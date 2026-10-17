// Unknown diagnostics remain blocking. Only complete, known informational lines
// are advisory; an advisory cannot hide a second, blocking diagnostic.
const ADVISORIES = [
  /^Host-managed MCP permissions require live verification; only the declared read-only research tools are authorized\.$/,
  /^Research MCP catalog filtering unavailable; inherited host tool permissions remain\. Remote-effect enforcement is not verified\.$/,
  /^Controller applied \d+ validated test-file edit\(s\)\. Test execution remains assigned separately\.$/
];
export function blockingReviewWarning(operation) {
  const warning = operation?.result?.warning;
  if (!warning) return null;
  return warning.split('\n').filter(line => line.trim() && !ADVISORIES.some(pattern => pattern.test(line))).join('\n') || null;
}
