# Field guide

Notes for the rounds a senior data engineering interview is built from: SQL, Python, data modeling, system design, and the engine and operations questions that come up inside them.

The drills are the part of this repository that is tested: every SQL and Python answer they contain is run by the test suite. This guide is prose. The [concept pages](../concepts/) cover the same ground one idea at a time, with examples that are run and the follow-up questions for each, and the [paths](../paths/) put them in order for each round. Use it as a checklist of what to be able to say and why, and check anything engine-specific against that engine's documentation before you rely on it.

1. [SQL](#sql)
2. [Python](#python)
3. [Data modeling](#data-modeling)
4. [Data system design](#data-system-design)
5. [Spark, warehouses and performance](#spark-warehouses-and-performance)
6. [Orchestration, data quality, governance and operations](#orchestration-data-quality-governance-and-operations)

## SQL

SQL appears in essentially every DE loop, and at senior level the bar is a correct answer first time, a clear explanation, and a good reply to "now make it fast on 10 billion rows". Six patterns cover most questions.

| Pattern | Typical prompt | The tool |
| --- | --- | --- |
| Dedupe / latest record | Keep the latest version of each order | `ROW_NUMBER() OVER (PARTITION BY key ORDER BY updated_at DESC)`, keep rn = 1 |
| Top N per group | Top 3 drivers by earnings per city | Aggregate, then `DENSE_RANK()` partitioned by the group |
| Rolling metrics | 7-day rolling DAU or revenue | A date spine plus `ROWS BETWEEN 6 PRECEDING AND CURRENT ROW` |
| Sessionization | Split clicks into sessions on a 30-minute gap | `LAG()` to flag a new session, then a running `SUM()` |
| Gaps and islands | Longest login streak | Date minus `ROW_NUMBER()` gives a constant per streak |
| Retention and funnels | Week-1 retention by signup cohort; signup to purchase funnel | First event per user, then a conditional `COUNT(DISTINCT ...)` |

### Where to practise each pattern

| Pattern | Drills |
| --- | --- |
| Dedupe / latest record | [dedupe-latest](../drills/sql/01-dedupe-latest.toml), [sum-after-dedupe](../drills/sql/02-sum-after-dedupe.toml) |
| Top N per group | [top-n-ties](../drills/sql/03-top-n-ties.toml) |
| Rolling and period-over-period metrics | [rolling-7d-missing-days](../drills/sql/04-rolling-7d-missing-days.toml), [mom-growth-missing-month](../drills/sql/05-mom-growth-missing-month.toml) |
| Sessionization | [sessionize-datediff](../drills/sql/06-sessionize-datediff.toml) |
| Gaps and islands | [login-streaks-duplicates](../drills/sql/07-login-streaks-duplicates.toml), [consecutive-months-year-boundary](../drills/sql/08-consecutive-months-year-boundary.toml) |
| Retention and funnels | [cohort-retention-where-filter](../drills/sql/09-cohort-retention-where-filter.toml), [funnel-event-order](../drills/sql/10-funnel-event-order.toml) |
| Anti-joins and reconciliation | [not-in-null](../drills/sql/11-not-in-null.toml), [reconcile-null-and-missing](../drills/sql/18-reconcile-null-and-missing.toml) |
| Joins and re-aggregation | [fanout-join-sum](../drills/sql/12-fanout-join-sum.toml), [avg-of-averages](../drills/sql/13-avg-of-averages.toml) |
| Dates and time zones | [local-day-boundary](../drills/sql/14-local-day-boundary.toml), [between-timestamp-end](../drills/sql/15-between-timestamp-end.toml) |
| Slowly changing dimensions | [scd2-as-of-join](../drills/sql/16-scd2-as-of-join.toml), [scd2-load-null-change](../drills/sql/17-scd2-load-null-change.toml) |

The reference answer in each drill is the template for its pattern, and the test suite runs every one of them. They are written for DuckDB with quoted interval literals (`INTERVAL '7 days'`), the form PostgreSQL also accepts; PostgreSQL rejects the unquoted `INTERVAL 7 DAY` that DuckDB allows. Redshift, Snowflake and BigQuery differ again in their date functions, so say which dialect you are writing.

### Traps interviewers plant

| Trap | What goes wrong | Drills |
| --- | --- | --- |
| Duplicates | A feed resends rows, or a table is finer than the thing you count, and sums inflate. | [dedupe-latest](../drills/sql/01-dedupe-latest.toml), [sum-after-dedupe](../drills/sql/02-sum-after-dedupe.toml), [login-streaks-duplicates](../drills/sql/07-login-streaks-duplicates.toml) |
| Ties | `ROW_NUMBER`, `RANK` and `DENSE_RANK` only differ when values tie. Ask which the business wants. | [top-n-ties](../drills/sql/03-top-n-ties.toml) |
| Missing rows | Without a date spine, a 7-row window spans more than 7 days and `LAG` skips a month. A filter in `WHERE` turns a left join into an inner join. | [rolling-7d-missing-days](../drills/sql/04-rolling-7d-missing-days.toml), [mom-growth-missing-month](../drills/sql/05-mom-growth-missing-month.toml), [cohort-retention-where-filter](../drills/sql/09-cohort-retention-where-filter.toml) |
| NULLs | One NULL makes `NOT IN` return nothing, and `<>` never reports a NULL as different. | [not-in-null](../drills/sql/11-not-in-null.toml), [reconcile-null-and-missing](../drills/sql/18-reconcile-null-and-missing.toml), [scd2-load-null-change](../drills/sql/17-scd2-load-null-change.toml) |
| Fan-out and grain | A join multiplies rows before an aggregate, or an average of averages ignores the weights. | [fanout-join-sum](../drills/sql/12-fanout-join-sum.toml), [avg-of-averages](../drills/sql/13-avg-of-averages.toml) |
| Time | `DATEDIFF` counts boundaries, `BETWEEN` on a timestamp loses the last day, month numbers forget the year, and "yesterday" depends on the time zone. | [sessionize-datediff](../drills/sql/06-sessionize-datediff.toml), [between-timestamp-end](../drills/sql/15-between-timestamp-end.toml), [consecutive-months-year-boundary](../drills/sql/08-consecutive-months-year-boundary.toml), [local-day-boundary](../drills/sql/14-local-day-boundary.toml), [funnel-event-order](../drills/sql/10-funnel-event-order.toml) |
| History | Joining to the current row of a Type 2 dimension rewrites the past. | [scd2-as-of-join](../drills/sql/16-scd2-as-of-join.toml) |

### The scale follow-up: what to say

When asked to make a query fast on a huge table, cover these in order:

1. **Prune data:** filter on partition and sort keys first (Redshift sort keys, Snowflake clustering, Delta/Iceberg partitions and Z-order).
2. **Shrink before joining:** aggregate or filter each side first, then join.
3. **Avoid shuffles:** co-locate join keys (Redshift `DISTKEY`), broadcast the small side.
4. **Precompute:** materialized views or incremental summary tables for repeated dashboard queries.
5. **Prove it:** read the `EXPLAIN` plan and compare rows scanned before and after.

Point 5 is the one that matters. [results/scale.json](../results/scale.json) holds a run of these claims on 100 million rows in DuckDB, and three of the textbook answers did not behave as the textbook says:

- A filter wrapped in `strftime` read every row, as expected. The same filter wrapped in `date_trunc` did not: the optimizer rewrote it into a range and it cost the same as the range.
- `ROW_NUMBER() ... rn = 1` and `arg_max ... GROUP BY` took the same time, because the optimizer turned the window into the aggregate.
- Aggregating before a join to a small dimension was slower than joining first.

None of that transfers to another engine unchanged, which is the point: say what you would expect, then say how you would check it.

### Practice questions

1. Daily active users and a 7-day rolling average, with zero-activity days included.
2. For each user, the time between their first and second purchase.
3. Users who ordered in three or more consecutive months.
4. Month-over-month revenue growth by region.
5. The most common 3-page sequence in a clickstream.
6. Each order's customer address at the time of the order, using an SCD Type 2 table.
7. Week-1 and week-4 retention by signup cohort.
8. Orders in the source system that are missing or different in the warehouse (a reconciliation query).

## Python

Data engineering coding rounds are mostly practical data wrangling with plain Python, not hard algorithms. Expect parsing, dictionaries, aggregation and streaming-style processing, plus easy-to-medium algorithm problems at some of the large technology companies. Usually no pandas, no running code, sometimes a shared doc.

**What they're judging:** correct handling of messy input, clean and readable code, sensible complexity, and whether you think about memory when the file is 100 GB.

### Where to practise

| Skill | Drills |
| --- | --- |
| Parsing messy input | [slowest-endpoints-p95](../drills/python/05-slowest-endpoints-p95.toml), [csv-quoted-commas](../drills/python/08-csv-quoted-commas.toml), [flatten-json](../drills/python/04-flatten-json.toml) |
| Streaming and laziness | [merge-sorted-streams](../drills/python/06-merge-sorted-streams.toml), [latest-by-key-late-arrival](../drills/python/03-latest-by-key-late-arrival.toml) |
| Windows and time zones | [tumbling-windows-timezones](../drills/python/02-tumbling-windows-timezones.toml) |
| Ties and exact comparison | [second-highest-ties](../drills/python/01-second-highest-ties.toml), [reconcile-float-money](../drills/python/07-reconcile-float-money.toml) |

### Habits that score points

- **Ask about the input first:** size, format, can lines be malformed, are timestamps in order, what time zone.
- **Stream, don't load:** iterate line by line or use generators; say what stays in memory (the dictionary of keys) and what doesn't.
- **Say what you'd do at scale:** "In production this is a Spark job partitioned by key" or "this becomes a stateful stream with a watermark for late events".
- **Handle edge cases out loud:** empty input, ties, duplicates, late or out-of-order events.
- **Name the complexity** of your solution before they ask.

### Practice prompts

1. Parse web server logs and return the 5 slowest endpoints by p95 latency.
2. Merge two sorted event streams into one sorted stream without loading either fully.
3. Given parent-child pairs, build a tree and print each node's full path.
4. Join a stream of recommendations with a stream of plays and flag plays that came from a recommendation within 10 minutes.
5. Validate a CSV against a schema (types, required fields) and report bad rows with reasons.
6. Implement a simple rate limiter or a sliding-window counter.
7. Reconcile two lists of transactions and report missing, extra and mismatched amounts.

## Data modeling

This is the round that most often decides senior versus mid-level. Interviewers give you a product ("a ride-sharing app") and watch whether you start from the business questions, state the grain clearly, and handle history and change. Then they often ask you to write SQL against your own model.

### The six-step approach

1. **Ask what decisions the data serves.** List 4–6 business questions before drawing anything.
2. **Name the business processes** (trip requested, trip completed, payment, rating). Each one usually becomes a fact table.
3. **Declare the grain** of every fact table in one sentence: "one row per completed trip". This is the step people skip and get marked down for.
4. **Pick the dimensions** that describe each fact (who, what, where, when) and the measures (amounts, durations, counts).
5. **Decide how history works:** which attributes change and need SCD Type 2, and which can be overwritten (Type 1).
6. **Check it against the questions:** walk through one question as a query to prove the model answers it.

### Worked example: ride-sharing app

**Business questions:** trips and revenue per city per day; driver earnings and acceptance rate; average wait time; rider retention; surge pricing impact.

| Table | Grain | Key columns |
| --- | --- | --- |
| `fact_trip` | One row per trip request (completed or not) | trip_id, rider_key, driver_key, city_key, request_date_key, status, requested_at, accepted_at, picked_up_at, dropped_off_at, distance_km, fare, surge_multiplier |
| `fact_payment` | One row per payment event (charge, refund, tip) | payment_id, trip_id, rider_key, payment_type, amount, currency |
| `fact_driver_status_snapshot` | One row per driver per day | driver_key, date_key, hours_online, trips_offered, trips_accepted |
| `dim_rider` | One row per rider version (SCD 2) | rider_key, rider_id, home_city, signup_date, valid_from, valid_to, is_current |
| `dim_driver` | One row per driver version (SCD 2) | driver_key, driver_id, vehicle_type, rating_band, valid_from, valid_to, is_current |
| `dim_city`, `dim_date` | One row per city / per day | timezone, country; day, week, month, holiday flag |

**Decisions to say out loud:**

- Keep cancelled and unaccepted requests in `fact_trip` with a status, so acceptance rate and cancellation rate are possible.
- Separate payments from trips, because one trip can have several payment events (tip, refund).
- Use a daily snapshot for driver availability, since it's a state over time rather than an event.
- Store timestamps in UTC plus the city's local date, so "trips per day" means the local day.

### SCD Type 2

Loading a Type 2 dimension and joining facts to it are both drills: [scd2-load-null-change](../drills/sql/17-scd2-load-null-change.toml) and [scd2-as-of-join](../drills/sql/16-scd2-as-of-join.toml).

In production you'd use `MERGE` (or dbt snapshots) and a hash of the tracked columns to detect changes. To get the attribute as of an event, join on `event_date BETWEEN valid_from AND valid_to`.

### Follow-up probes to prepare for

- **Late-arriving dimensions:** a trip arrives before its driver record. Use an "unknown" placeholder row and fix it up later.
- **Late-arriving facts:** an event from last week arrives today. Partition by event date and reprocess that partition.
- **Many-to-many:** a trip with several riders (pool). Use a bridge table.
- **Star schema vs one big table vs Data Vault:** star for BI, wide denormalized tables for dashboards that need speed, Data Vault when many sources change often and auditability matters.
- **Changing grain:** "now we need it per trip leg". Show how you'd add a new fact rather than break the old one.

### Practice prompts

Model each in 25 minutes, then write two queries against it:

1. A food-delivery marketplace (orders, restaurants, couriers, refunds).
2. A music streaming app (plays, playlists, subscriptions).
3. A lending platform: applications, loans, repayments, credit checks.
4. An e-commerce site with split shipments from several warehouses.
5. A notification system: sends, opens, clicks, unsubscribes.
6. Greenhouse sensor readings and harvests across sites.

## Data system design

This is where lead candidates are separated from senior ones. You get a vague prompt ("design real-time analytics for a ride-sharing app") and 45–60 minutes. The interviewer wants to see you drive: clarify requirements, sketch an end-to-end design, then go deep on the hard parts and the trade-offs.

### A framework for the 45 minutes

1. **Requirements (5–8 min).** Who uses the output and for what? Freshness SLA (seconds, minutes, daily)? Volume (events per second, GB per day, history to keep)? Correctness (can numbers be approximate, must money be exact)? Cost limits, compliance (PII, data residency)?
2. **Sources and contracts (3 min).** Event streams, database CDC, third-party APIs, files. Who owns the schema and how changes are announced.
3. **High-level design (10 min).** Ingestion → raw storage → processing → serving, drawn left to right. Name the tools but explain the role first.
4. **Deep dives (15–20 min).** Pick the two hardest parts and go deep: late data, exactly-once, backfills, schema evolution, hot keys.
5. **Operations (5 min).** Data quality checks, monitoring and alerting, on-call, cost controls, how you'd roll it out.
6. **Trade-offs and what you'd do next (3 min).** Say what you'd simplify for version one.

```text
Reference pipeline architecture (5 layers)

 SOURCES            INGEST              RAW LAKE (bronze)      PROCESS                SERVE
 app events   -->   Kafka / Kinesis -->  S3, immutable,    -->  Spark / Glue / dbt -->  Warehouse (BI)
 DB via CDC   -->   Debezium / DMS        partitioned by date   silver: cleaned        OLAP store (live dashboards)
 vendor APIs  -->   Lambda / Airbyte      Parquet + Delta/      gold: modeled          Key-value (app lookups)
 files        -->   batch loaders         Iceberg               (facts, dimensions)

 Cross-cutting: Airflow orchestration · data quality checks · catalog and lineage · monitoring and alerts
```

Most answers fit this shape. The raw lake is the piece interviewers probe most: keeping raw data immutable is what makes backfills, replays and audits possible.

### Concepts you must be able to explain

| Concept | What to say |
| --- | --- |
| Batch vs streaming | Stream only what needs minute-level freshness; batch is cheaper and simpler. Many designs use both (a fast path and a corrected daily path). |
| Idempotency | Every job can be rerun safely: write by partition with overwrite, or `MERGE` on a key. Never blind appends. |
| Exactly-once | In practice: at-least-once delivery plus deduplication on an event ID, or transactional sinks (Kafka transactions, Delta/Iceberg commits). |
| Late and out-of-order data | Event time vs processing time, watermarks, allowed lateness, and a daily batch that corrects the streaming numbers. |
| Backfills | Parameterize jobs by date, keep raw data immutable so you can replay, and run backfills in a separate queue so they don't starve daily jobs. |
| CDC | Read the database log (Debezium, DMS, binlog) instead of polling; handle deletes, schema changes and the initial snapshot. |
| Schema evolution | Data contracts with producers, a schema registry, additive changes only without a version bump. |
| Partitioning and file layout | Partition by date (and a low-cardinality key), avoid small files with compaction, cluster or Z-order on filter columns. |
| Storage formats | Parquet for columnar scans; Delta or Iceberg for ACID commits, time travel and `MERGE`. |
| Serving | Warehouse for BI, an OLAP store (Pinot, Druid, ClickHouse) for sub-second dashboards, key-value for app lookups. |
| Data quality | Checks at ingestion (schema, nulls, volume) and after transformation (uniqueness, reconciliation to source), with failures that stop bad data spreading. |
| Cost | Right-size clusters, spot instances for batch, lifecycle rules on old data, avoid full scans. |

### Worked design 1: real-time ride analytics

**Prompt:** city operations teams need live trips, wait times and surge by city, under 1 minute stale; finance needs exact daily revenue.

- **Ingest:** app and backend events to Kafka (or Kinesis), keyed by city, with a schema registry.
- **Stream:** Flink or Spark Structured Streaming computes 1-minute windows by city using event time, a watermark of a few minutes, and dedupe on event ID.
- **Serve live:** results go to an OLAP store (Pinot or Druid) behind the ops dashboard.
- **Batch truth:** raw events also land in S3 as Iceberg/Delta (bronze). A nightly job rebuilds silver and gold tables with late events included; finance reads only the batch numbers.
- **Deep dives:** hot keys for big cities (salt the key or pre-aggregate), replays after an outage (idempotent sinks), and why live and finance numbers can differ for a few hours.

### Worked design 2: CDC from an operational database into the lakehouse

**Prompt:** replicate a Postgres loan-origination database into the warehouse every 15 minutes, with full history, without loading the production database.

- **Capture:** Debezium or AWS DMS reads the write-ahead log; an initial snapshot first, then changes.
- **Land:** changes go to a raw table in S3 (append-only, partitioned by ingest date).
- **Apply:** a scheduled job `MERGE`s the latest change per primary key into a current-state table, and appends to a history table (SCD 2 style).
- **Deep dives:** deletes (soft-delete flag), schema changes (column added mid-stream), ordering by log sequence number not timestamp, reconciliation counts between source and target.

### Worked design 3: integrating many third-party sources

**Prompt:** ingest data from 20 SaaS and vendor APIs (CRM, ERP, payments) into one model.

- A connector framework (Airbyte, Fivetran, or custom Lambdas for webhooks) landing raw JSON with metadata (source, extracted_at, request ID).
- Incremental extraction with cursors, rate-limit handling and retries with backoff.
- Webhook callbacks archived before processing, then applied idempotently.
- Entity resolution across sources (the customer in the CRM is the borrower in the loan system), with match rules and a review queue.
- Dashboards for freshness and failure per source; paid or irreversible calls never auto-retried.

### Practice prompts

1. A clickstream pipeline for a news site: sessions, top articles in the last hour, and daily engagement.
2. A feature store for ML with point-in-time correct training data.
3. A pipeline that must reprocess 90 days of data in 4 hours without disrupting daily jobs.
4. Data lake governance: PII tagging, column-level access and audit for a regulated lender.
5. IoT sensor data from greenhouses: millions of readings per hour, anomaly alerts within 5 minutes, and long-term trends.
6. Migrating a legacy ETL tool (Talend, SSIS) to Airflow and Databricks without downtime.

## Spark, warehouses and performance

Deep-dive questions test whether you understand why things are slow, not whether you can recite settings. The strongest answers follow one pattern: how you'd diagnose it (Spark UI, query plan, system tables), the cause, the fix, and how you'd prove the fix worked.

### Spark questions and short answers

| Question | Answer to give |
| --- | --- |
| What is a shuffle and what causes one? | Moving data between executors so rows with the same key meet: joins, `groupBy`, `distinct`, `repartition`, window functions. It's the main cost in most jobs because it hits disk and network. |
| One task takes 20x longer than the rest. Why? | Data skew: a hot key. Confirm in the Spark UI (task duration and shuffle read size per task). Fix with AQE skew-join handling, salting the key, broadcasting the small side, or handling the hot key separately. |
| When does salting not work? | For aggregates that can't be combined in two steps (like exact distinct counts or medians) without extra work; salting also adds a second aggregation stage. |
| Broadcast join: when and when not? | When one side fits comfortably in executor memory (tens to a few hundred MB). Not for big tables: it causes driver and executor out-of-memory errors. |
| What does Adaptive Query Execution do? | Re-plans at runtime using real statistics: coalesces small shuffle partitions, switches to broadcast joins, splits skewed partitions. |
| `repartition` vs `coalesce`? | `repartition` does a full shuffle to any number of evenly sized partitions; `coalesce` only merges partitions without a shuffle, so it's cheap but can leave uneven ones. Avoid `coalesce(1)` on big data. |
| `spark.sql.shuffle.partitions` vs `maxPartitionBytes`? | The first sets partitions after a shuffle (default 200); the second controls how input files are split when reading. |
| Small-files problem? | Thousands of tiny files slow reads and metadata operations. Fix with compaction (`OPTIMIZE`), fewer, larger writes, and target file sizes around 128 MB–1 GB. |
| Executor out of memory? | Check skew first, then too few partitions, huge broadcasts, `collect()` to the driver, or caching too much. Increase partitions before increasing memory. |
| When does caching help? | When the same DataFrame is reused several times in a job, and it fits. Otherwise it wastes memory. |
| How do you read an `explain()` plan? | Look for exchanges (shuffles), the join strategy (broadcast hash vs sort-merge), and whether filters are pushed down to the scan. |
| Delta Lake vs Iceberg? | Both add ACID commits, time travel and `MERGE` on top of Parquet. Delta is tightly integrated with Databricks; Iceberg is engine-neutral, with hidden partitioning and strong multi-engine support. |

### Warehouse questions

| Question | Answer to give |
| --- | --- |
| How do you tune Redshift? | Distribution keys on the main join column (or ALL for small dimensions), sort keys on the usual filter column, `VACUUM`/`ANALYZE`, WLM queues to separate ETL from BI, concurrency scaling, and materialized views. Check `SVV_TABLE_INFO` for skew. |
| How does Snowflake prune data? | It stores data in micro-partitions with min/max metadata and skips partitions that can't match a filter. Clustering keys help on very large tables filtered by the same columns. |
| BigQuery cost control? | Partition and cluster tables, select only needed columns, and set query byte limits. |
| Postgres query got slow as a table grew | `EXPLAIN ANALYZE`, check for sequential scans, use the right index (including expression or partial indexes), then `pg_stat_statements` to find the worst queries. |

### How to tell a performance story

Use the same four beats every time: the symptom and its business cost, how you measured it, the cause and the fix, and the before-and-after evidence. Expect the interviewer to push hardest on the "how did you know" part.

## Orchestration, data quality, governance and operations

These topics come up inside the design round and the project deep dive rather than as their own round. For a lead role, they're where you show you've run a platform in production, not just built pipelines.

### Questions and what a strong answer covers

| Question | What to cover |
| --- | --- |
| How do you structure Airflow DAGs? | Small, idempotent tasks; parameterized by the run date (`data_interval_start`); no heavy processing inside Airflow itself, just orchestration of Spark, dbt or warehouse jobs; retries with backoff; SLAs and alerts; DAG tests in CI. |
| How do you backfill safely? | Jobs write whole partitions with overwrite, so reruns are safe; run backfills in a separate pool with limited concurrency; check row counts against the source after. |
| How do you use dbt well? | Staging, intermediate and mart layers; tests on keys (unique, not null, relationships) and accepted values; incremental models with a clear unique key; sources with freshness checks; documentation and lineage. |
| How do you guarantee data quality? | Checks at three points: on arrival (schema, volume, nulls), after transformation (uniqueness, referential integrity, business rules), and reconciliation against the source of truth. Decide which failures stop the pipeline and which only warn. |
| What's a data contract? | An agreed schema and meaning between a producer team and the data team, versioned, with breaking changes announced. It stops upstream changes silently breaking dashboards. |
| How do you handle PII? | Classify columns, mask or tokenize in non-production, column- and row-level access controls (Unity Catalog, Lake Formation), encryption at rest and in transit, and audit logs. |
| How do you monitor pipelines? | Freshness, volume and failure alerts per pipeline; dashboards for SLA misses; on-call runbooks; incident reviews that fix the cause, not the symptom. |
| How do you control cloud cost? | Tag resources by team, auto-terminate clusters, spot instances for batch, lifecycle policies on old data, and review the most expensive queries monthly. |
| How do you deploy data infrastructure? | Terraform for infrastructure, CI/CD (GitHub Actions) for pipelines and dbt, separate dev/staging/prod environments, and code review on every change. |
