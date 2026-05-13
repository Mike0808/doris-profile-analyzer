# Sample Profiles

This directory stores Apache Doris query profiles used as fixtures for the
parser and as regression tests.

All samples come from **TPC-H** and **TPC-DS** benchmarks generated with the
official Doris tooling. These benchmarks use publicly published synthetic
schemas — there is no PII concern, samples can be committed to git as-is.

---

## Selected queries

The selection is deliberately small. Each query exercises a specific set of
operators so the parser gets coverage without dragging in all 22 + 99 queries.

### TPC-H @ SF1 (5 queries)

| Query | Why it's here | Operators it exercises |
| --- | --- | --- |
| **Q01** | Smallest meaningful query — scan + aggregate + sort. Parser smoke test. | OLAP_SCAN, AGGREGATION, SORT |
| **Q03** | 3-way join with date filters, GROUP BY, ORDER BY, LIMIT. | + HASH_JOIN (inner), EXCHANGE |
| **Q05** | 6-way star join (region → nation → supplier → lineitem → orders → customer). Shows broadcast vs shuffle decisions. | Complex HASH_JOIN graph |
| **Q09** | 6-way join with a derived table. Long chain — stress test for plan tree visualization. | Deep HASH_JOIN chain |
| **Q21** | Self-join of `lineitem` 3 times + `NOT EXISTS`. Showcase for anti-join and runtime filters. | HASH_JOIN (anti-semi), runtime filter info |

Optional add-on if you want correlated-subquery coverage:
- **Q17** — correlated subquery on `lineitem`; Doris typically decorrelates
  to a HASH_JOIN but may fall back to NESTED_LOOP_JOIN under some configs.

### TPC-DS @ SF1 (5 queries)

| Query | Why it's here | Operators it exercises |
| --- | --- | --- |
| **Q04** | UNION ALL of three customer cohorts (year-over-year). | SET_OPERATION, multiple AGGREGATION blocks |
| **Q23** | IN subquery with INTERSECT-like pattern. | Semi-join decorrelation, multi-subquery plan |
| **Q67** | Window function (rank over partition) combined with ROLLUP. | ANALYTIC, REPEAT |
| **Q70** | ROLLUP with sub-aggregations. | REPEAT (grouping sets) — cleaner isolation than Q67 |
| **Q95** | Multiple CTEs joining heavy fact tables. | Deep plan tree, multi-stage exchanges |

Total: **10 queries**. Together they cover every operator listed as priority
1–9 in `CLAUDE.md`.

---

## Generating samples

Run these once after setting up a Doris 3.x cluster.

### 1. Generate data and load tables

Doris ships official scripts in the main repo:

- TPC-H: `tools/tpch-tools/` in `apache/doris`
- TPC-DS: `tools/tpcds-tools/` in `apache/doris`

```bash
# Clone (shallow is fine)
git clone --depth 1 https://github.com/apache/doris.git
cd doris/tools/tpch-tools

# Generate SF1 data (~1 GB), create tables, stream-load into Doris
bash bin/build-tpch-dbgen.sh
bash bin/gen-tpch-data.sh -s 1
bash bin/create-tpch-tables.sh
bash bin/load-tpch-data.sh

# Same pattern for TPC-DS
cd ../tpcds-tools
bash bin/build-tpcds-dsdgen.sh
bash bin/gen-tpcds-data.sh -s 1
bash bin/create-tpcds-tables.sh
bash bin/load-tpcds-data.sh
```

Verify the exact script names against the current state of `apache/doris`
master before running — they evolve. The official docs at
`https://doris.apache.org/docs/3.x/benchmark/` are authoritative.

### 2. Enable profiling

In your MySQL client connected to Doris FE on port 9030:

```sql
SET enable_profile = true;
-- Optionally:
SET parallel_pipeline_task_num = 8;
```

### 3. Run each selected query and capture its profile

Workflow per query:

```sql
-- Run the query (SQL is in tools/tpch-tools/queries/q01.sql etc.)
SOURCE tools/tpch-tools/queries/q01.sql;
-- Capture query_id from the result or from `SHOW QUERY PROFILE "/";`
```

Then for **each** query_id, save **both** the text and JSON forms:

```bash
QID="<query_id>"

# Text form (preferred for human reading)
curl -s -u root: "http://FE_HOST:8030/api/profile_text?query_id=${QID}" \
  > samples/tpch/q01_sf1.txt

# JSON form (for testing JSON unwrap path)
curl -s -u root: "http://FE_HOST:8030/api/profile?query_id=${QID}" \
  > samples/tpch/q01_sf1.json
```

If `/api/profile_text` is not available on your build, use the SQL form:

```sql
SHOW QUERY PROFILE "/<query_id>";
```

and copy the output into `q01_sf1.txt`.

### 4. Naming convention

```
samples/tpch/q01_sf1.txt
samples/tpch/q01_sf1.json
samples/tpcds/q04_sf1.txt
samples/tpcds/q04_sf1.json
```

If you capture the same query at a different scale or with different session
settings, suffix accordingly: `q05_sf1_no_runtime_filter.txt`.

---

## Note on profile API endpoints

The exact endpoint paths and field names should be verified against
`https://doris.apache.org/docs/3.x/admin-manual/open-api/fe-http/query-profile-action/`
before being relied on in code. Doris reorganizes the FE HTTP API between
minor versions occasionally.
