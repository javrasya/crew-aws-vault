# crew-aws-vault

A [crew](https://github.com/javrasya/crew) extension (protocol 1, see crew's `docs/extensions.md` and ADR-0044) that keeps every agent's AWS credentials fresh through [aws-vault](https://github.com/99designs/aws-vault), whatever harness runs it: Claude Code, pi, or a plain program.

Without it, `aws-vault exec <profile> -- crew start <spec>` fixes the short-lived keys aws-vault exported into every agent of the run; once they expire, every AWS call fails, and keeps failing after a park and revive.

## How it works

- **A credentials server.** The extension serves credentials on `127.0.0.1` the way the container credential provider asks for them. On every `session.starting` (log tails aside) whose env names a profile (`AWS_VAULT`, else `AWS_PROFILE`, else the config file's below), it sets `AWS_CONTAINER_CREDENTIALS_FULL_URI` and `AWS_CONTAINER_AUTHORIZATION_TOKEN`, and unsets the keys that would win over them (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_SECURITY_TOKEN`, `AWS_CREDENTIAL_EXPIRATION`, `AWS_PROFILE`, `AWS_VAULT`). The AWS CLI and SDKs fetch from it, and fetch again before their credentials run out, so a running agent never needs a restart.
- **One refresh for all.** Each profile's credentials come from `aws-vault export --format=json <profile>`, shared by every session: a keychain or SSO prompt happens once, not once per agent. Credentials within 15 minutes of expiry are refreshed behind the fetch that finds them; for expired ones the fetch waits on the refresh for at most 0.8 s, since an SDK gives up on the container endpoint after about a second, and is refused with a 503 past that.
- **A held start.** A start that has to wait on aws-vault is held (manifest `holdMs`, 5 minutes). If aws-vault opens an SSO sign-in, the agent's row shows its link and code, and a `warn` notice gives it once.
- **When aws-vault fails**, an `error` notice says why, and aws-vault is not asked again for 2 minutes (`CREW_AWS_VAULT_COOLDOWN_MS`). A session started under `aws-vault exec` (`AWS_VAULT` set) is pointed at the server all the same, and gets credentials once aws-vault works again. One with only `AWS_PROFILE`, which may not be an aws-vault profile at all, starts with the env it was given.
- **Expired tokens in tool output.** On a failed `tool.result` from a session it set up whose output shows an expired token (`ExpiredToken`, "security token included in the request is expired" or "invalid", an expired SSO session, the CLI's failed container fetch), it renews the profile's credentials and, if aws-vault gave new ones, types into that agent, once per renewal, that it may retry.
- **Restarts.** The server's port and token, and which session uses which profile, are kept in `aws-vault.json` in crew's home (mode 0600), so the sessions set up before a crash, `crew reload` or `crew update` keep working.
- **pi stands down.** It sets `PI_AWS_PROFILE=crew-aws-vault`, a profile with no SSO sign-in, so the `aws-vault-refresh` pi extension in funnel-io/agent-ops does nothing in a crew agent, rather than prompting per agent and pinning static keys over the server's.

## Install

```
crew install <path to this folder>
crew extensions
```

To give sessions a profile when the shell that starts them names none, write it to `aws-vault.config.json` in crew's home (read on every start, no reload needed):

```json
{ "profile": "funnel-ai-dev" }
```

Then start runs as before, `aws-vault exec <profile> -- crew start <spec>`, or with `AWS_PROFILE` set. Set `AWS_VAULT_BIOMETRICS=1` in the shell that starts crew's daemon to make a keychain prompt a Touch ID tap.

## Develop

```
npm test           # the extension under crew's own bootstrap, with a fake aws-vault (needs crew checked out beside this repo, or CREW_DIR)
npm run typecheck
```
