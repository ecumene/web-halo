# AWS native gateway deployment

The browser/native bridge uses a deliberately small hybrid deployment:

- Cloudflare Worker: origin checks, bans, rate limiting, Turnstile, and signed
  session issuance.
- CloudFront: public TLS and WebSocket transport.
- Caddy on EC2: an origin-only reverse proxy to the private HTTP listener.
- EC2: the authenticated native UDP data plane.

The instance has no SSH key. Administration uses AWS Systems Manager Session
Manager. Its security group accepts TCP only from AWS's managed CloudFront
origin-facing prefix list and exposes only the configured UDP range directly.
The root disk is encrypted, IMDSv2 is mandatory, the shared secret is loaded
from encrypted SSM Parameter Store, and both containers run read-only with
dropped Linux capabilities. Caddy serves only the three gateway routes. Logs
are retained in `/halo/native-gateway` for 14 days.

The default three-GB daily gateway cap keeps a full month below 100 GB of
gateway traffic. It is a safety ceiling, not a promise of capacity: native to
native games remain peer-to-peer and do not use this instance.

## Required secret parameter

Create these as `SecureString` values before deploying:

- `/halo/native-gateway/control-secret`: the same value as the signaling
  Worker's `NATIVE_GATEWAY_SECRET` secret.

Pass the regional `com.amazonaws.global.cloudfront.origin-facing` managed
prefix list ID as `CloudFrontOriginPrefixListId`. Set the signaling Worker's
`NATIVE_GATEWAY_CONTROL_URL` to the stack's `WorkerControlUrl` output after its
health check passes. No Route 53 change is required.

Deploy `template.yml` into a public subnet in `ca-central-1`. Pass an immutable
gateway image tag such as
`ghcr.io/ecumene/halo-native-gateway:<main-commit-sha>` rather than `latest`.

After deployment, verify:

1. the stack's `GatewayHttpsUrl` plus `/health` returns `ok: true`;
2. the EC2 security group has no SSH ingress;
3. Session Manager can reach the instance; and
4. a browser can join a live native `halo://join/...` link.
