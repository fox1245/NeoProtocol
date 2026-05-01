// Pinning test for SPEC §16.4.1 — Virtual Path enforcement.
//
// Runs in node (acp.js is a pure-ES module; isVirtualPath +
// virtualPathSession have no browser deps). The test exists so that
// the safety-profile claim "any non-virtual path is rejected" survives
// future refactors.
//
// Run:  node examples/p2p-acp-poc/test_virtual_path.js

import { isVirtualPath, virtualPathSession } from "./acp.js";

let passed = 0, failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log("OK  ", label); }
  else      { failed++; console.error("FAIL", label); }
}

// ---- Accept ----
check("plain virtual path",          isVirtualPath("np://session/abc/notes.txt"));
check("nested key segments",         isVirtualPath("np://session/abc/folder/sub/key.json"));
check("session id with dashes",      isVirtualPath("np://session/s_1_xyz-123/x"));

// ---- Reject ----
check("real filesystem path",        !isVirtualPath("/etc/passwd"));
check("file:// URL",                 !isVirtualPath("file:///etc/passwd"));
check("http URL",                    !isVirtualPath("http://evil.example/secret"));
check("relative path",               !isVirtualPath("./notes.txt"));
check("Windows drive path",          !isVirtualPath("C:\\Users\\x"));
check("traversal segment '..'",      !isVirtualPath("np://session/abc/../def/x"));
check("traversal at end",            !isVirtualPath("np://session/abc/x/.."));
check("missing prefix",              !isVirtualPath("session/abc/x"));
check("wrong scheme",                !isVirtualPath("np://other/abc/x"));
check("empty string",                !isVirtualPath(""));
check("non-string (null)",           !isVirtualPath(null));
check("non-string (object)",         !isVirtualPath({}));
check("non-string (number)",         !isVirtualPath(42));

// ---- Session extraction ----
check("session id extracted",        virtualPathSession("np://session/abc/notes.txt") === "abc");
check("session id w/ no key",        virtualPathSession("np://session/abc") === "abc");
check("session id null on bad path", virtualPathSession("/etc/passwd") === null);
check("session id null on traversal", virtualPathSession("np://session/abc/../bad") === null);

// ---- Cross-session scope check (the FED-002 path-out-of-scope claim) ----
const activeSid = "s_42_real";
const goodPath  = `np://session/${activeSid}/x`;
const otherPath = `np://session/s_99_other/x`;
check("active session matches",       virtualPathSession(goodPath) === activeSid);
check("other session does not match", virtualPathSession(otherPath) !== activeSid);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
