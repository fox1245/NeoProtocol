// Cowork workspace — the Y.Doc + CodeMirror binding + edit attribution.
//
// SPEC §17 (draft):
//   - The Y.Doc is the workspace state.
//   - A `Y.Text` named "code" holds the document body.
//   - A `Y.Map` named "meta" holds attribution: every transaction is
//     tagged with { peerId, agentId? } so that remote peers can
//     visually attribute incoming edits ("A's agent applied this").
//   - Awareness carries cursor/selection + display name.

import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { yCollab } from "y-codemirror.next";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, rectangularSelection, crosshairCursor, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { syntaxHighlighting, defaultHighlightStyle, foldGutter, indentOnInput, bracketMatching, foldKeymap } from "@codemirror/language";
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";

const STARTER_DOC = `// Welcome to NeoProtocol Cowork — Stage 1 PoC
// Two browsers. One Y.js doc. Each user has their own agent.
// Try: type together. Then ask your agent to add JSDoc.

function add(a, b) {
  return a + b;
}

function multiply(a, b) {
  return a * b;
}
`;

export const ATTRIBUTION_AGENT_KEY = "agent_origin";

export function makeWorkspace({ container, displayName, color }) {
  const doc = new Y.Doc();
  const yText = doc.getText("code");
  const meta = doc.getMap("meta");
  const awareness = new Awareness(doc);

  // Display name + cursor color for the awareness layer (yCollab uses
  // these to render remote selections).
  awareness.setLocalStateField("user", {
    name: displayName,
    color,
    colorLight: color + "33"
  });

  // The first peer to touch the doc seeds the starter content. We
  // detect "I am the first" by checking sync state — if we receive
  // step2 from the remote and yText is still empty, leave it; if
  // nobody else is on the doc, seed.
  // For Stage 1 we just seed unconditionally on the first peer; Y.js
  // CRDT semantics make duplicate seeds idempotent (insert at 0
  // preserves both, but we guard with length check).
  const seedIfEmpty = () => {
    if (yText.length === 0) yText.insert(0, STARTER_DOC);
  };

  const view = new EditorView({
    state: EditorState.create({
      doc: "",
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
          indentWithTab
        ]),
        javascript(),
        yCollab(yText, awareness)
      ]
    }),
    parent: container
  });

  // Apply an agent-attributed edit. We compute a minimal diff against
  // the current doc (common-prefix + common-suffix trim) so cursor
  // positions are preserved as much as Y.js CRDT allows.
  function applyAgentEdit({ newText, agentId, peerId }) {
    const cur = yText.toString();
    if (cur === newText) return { changed: 0 };

    let prefix = 0;
    while (prefix < cur.length && prefix < newText.length && cur[prefix] === newText[prefix]) prefix++;
    let suffix = 0;
    while (
      suffix < (cur.length - prefix) &&
      suffix < (newText.length - prefix) &&
      cur[cur.length - 1 - suffix] === newText[newText.length - 1 - suffix]
    ) suffix++;

    const delLen = cur.length - prefix - suffix;
    const ins = newText.slice(prefix, newText.length - suffix);

    doc.transact(() => {
      if (delLen > 0) yText.delete(prefix, delLen);
      if (ins.length > 0) yText.insert(prefix, ins);
      // Stamp the transaction with attribution.
      meta.set(ATTRIBUTION_AGENT_KEY, {
        agentId,
        peerId,
        appliedAt: Date.now(),
        bytesIn: ins.length,
        bytesOut: delLen
      });
    }, { agentEdit: { agentId, peerId } });

    return { changed: ins.length + delLen, prefix, delLen, insLen: ins.length };
  }

  // Subscribe to attribution changes so the UI can flash a banner
  // when the *other* peer's agent applies an edit.
  function onAgentEdit(handler) {
    meta.observe((event) => {
      if (event.keysChanged.has(ATTRIBUTION_AGENT_KEY)) {
        const v = meta.get(ATTRIBUTION_AGENT_KEY);
        handler(v);
      }
    });
  }

  return { doc, yText, meta, awareness, view, seedIfEmpty, applyAgentEdit, onAgentEdit };
}
