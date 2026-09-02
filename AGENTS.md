# HappyClaw Agent Instructions

## Definition of done

- Completing a feature in source is not sufficient. Every completed feature must be built, deployed to the current Linux host's PM2 `happyclaw` service, and tested through the relevant runtime and public entry points.
- Do not report a feature as complete until the Linux deployment succeeds and the relevant production-environment checks pass.
- Preserve this Linux host's runtime data and configuration, follow [DEPLOYMENT.md](DEPLOYMENT.md), and report source-level verification separately from verification of the running Linux instance.
- The owner has explicitly opted out of deployment backups. Do not create SQLite snapshots, full runtime archives, or `.env` backup copies on this Linux host unless the owner explicitly reverses this policy in a future request.
