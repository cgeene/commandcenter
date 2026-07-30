/**
 * Lifetime bound for a test's scratch tmux server.
 *
 * The files that drive a real tmux server point TMUX_TMPDIR at a scratch
 * directory and tear the whole server down in `afterAll`. That teardown does not
 * run when the RUNNER is killed rather than the test — a reaped agent pane, a
 * Ctrl-C, or a daemon restart, which group-kills an in-flight verify because the
 * verify child shares the daemon's process group. A tmux server daemonises into
 * its own process group and reparents to pid 1, so nothing that kills the runner
 * reaches it: what is stranded is a whole tmux server, forever.
 *
 * So the scratch server carries its own bound, the same second line of defence
 * the process fixtures in ./procgroups.ts carry.
 */
export const SCRATCH_SERVER_SEC = 900;

/**
 * A hub-pane command that bounds the scratch server it runs in.
 *
 * The pane of a bare `new-session -n hub` runs the operator's login shell, which
 * never exits, which is why the server outlives its run. Passing this instead
 * gives that pane an exit, and the server an end.
 *
 * The server is killed OUTRIGHT rather than left to empty out: `exit-empty` is
 * on by default but cannot fire here, because `newWindow()` sets
 * `remain-on-exit` on every window the daemon creates and a killed run leaves
 * those behind as dead-pane corpses, which keep the session non-empty forever.
 *
 * Targets its own socket, read back from $TMUX, and does nothing at all when
 * $TMUX is unset: with no socket to read back there is none this can show is its
 * own, and whatever an empty `-S` resolves to is not it. The default socket is
 * the operator's own server, so this fails closed rather than guessing.
 *
 * Parameterised so a test can assert the bound behaviourally on a short one
 * rather than waiting out the real 900s.
 */
export function scratchHubCommand(lifetimeSec: number): string {
  return `sleep ${lifetimeSec}; [ -n "$TMUX" ] && exec tmux -S "\${TMUX%%,*}" kill-server`;
}
