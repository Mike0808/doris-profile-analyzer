# Doris Profile Analyzer

Client-side web application for analyzing **Apache Doris** query profiles.

Drop a profile from `SHOW QUERY PROFILE` or the FE HTTP `/api/profile` API
into the browser and get visual analysis of scan operators, join operators,
and the execution plan — entirely offline, no data leaves your machine.

Inspired by [fresha/northstar](https://github.com/fresha/northstar), which
does the same for StarRocks. Doris and StarRocks diverged in 2020 and their
profile formats are not interchangeable, hence this separate project.

## Status

Early development. See `CLAUDE.md` for architecture, scope, and contribution rules.

## Run locally

```bash
# Just open in browser
open index.html

# Or serve (recommended, avoids module CORS quirks)
python -m http.server 8000
# then http://localhost:8000
```

No build step. No dependencies.

## Generating test profiles

See `samples/README.md` for the TPC-H + TPC-DS workflow.

## License

MIT.
