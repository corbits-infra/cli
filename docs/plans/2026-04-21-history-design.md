# History Command Design

## Goal

Add a standalone `history` command that lets users inspect past successful paid
`corbits call` executions. The command should answer what resource was consumed,
how much was paid, which wallet and network were used, and optionally show a
saved response body when the user explicitly requested response capture during
the original call.

## Scope

In scope:

- record successful paid x402 calls from `corbits call`
- store normalized history records locally in an append-only JSONL file
- add `corbits history` for recent activity and filtering
- add `corbits history show <timestamp-ms>` for a single saved entry
- support optional response persistence via `corbits call --save-response`
- warn on stderr when a paid call succeeds but history persistence fails

Out of scope for v1:

- tracking `discover`, `inspect`, `config`, or unpaid `call` usage
- remote/server-backed history
- exposing the history file path as public CLI API
- global config to always save response bodies
- binary response fidelity guarantees
- precomputed summary caches or database-backed storage
- history file size limits or log rotation

## User Experience

### `corbits call`

On a successful paid x402 retry, `corbits call` appends a history record to the
internal JSONL history file.

Default behavior:

- save payment and request metadata only
- do not save the response body

Optional behavior:

- `--save-response` stores the response body alongside the same successful paid
  history record. Note: this flag is a permanent public API addition to `corbits
call` — the name and semantics should be considered final before shipping.
- `--save-response` is not supported for streamed responses (`"streamed-completed"`
  result). If the paid call produces a streamed response and `--save-response` is
  requested, the CLI should warn on stderr that response capture was skipped, but
  the metadata history record is still written normally.

Failure behavior:

- if the paid call succeeds and history persistence succeeds, behavior remains
  unchanged
- if the paid call succeeds but history persistence fails, the CLI still
  returns the paid call result and prints a warning to stderr
- if `--save-response` was requested, the warning should make clear whether the
  failure prevented all history persistence or only response persistence

Only successful paid calls are recorded. Free requests, wallet failures,
preflight failures, and unsuccessful retries are not written to history.

### `corbits history`

`corbits history` reads the internal JSONL file, parses valid entries, sorts by
`timestamp_ms` descending, applies filters, and prints results.

Default behavior:

- show the 20 most recent entries

V1 filters:

- `--wallet <value>`
- `--network <value>`
- `--host <value>`
- `--resource <value>`
- `--min-amount <value>` — base integer units (e.g. USDC micro-units, lamports).
  Display formatting is applied at render time via `formatTokenAmount()`.
- `--max-amount <value>` — same unit convention as `--min-amount`
- `--since <value>`
- `--until <value>`
- `--limit <n>`

Time parsing rules for `--since` and `--until`:

- accept Unix milliseconds
- accept Unix seconds
- accept ISO datetimes

Output behavior:

- table remains the default format
- JSON and YAML follow the existing CLI format conventions

### `corbits history show <index>`

Shows one saved history entry. `<index>` is the 1-based sequential position of
the entry in the JSONL file (i.e. line number), displayed in the `#` column of
`corbits history` output. This is stable for any given entry as long as the file
is append-only, and avoids requiring users to copy a 13-digit timestamp.

Default behavior:

- table output prints a readable metadata block
- if a response body was saved, print it after the metadata block

Structured output:

- JSON and YAML return the full stored record

## Storage Design

### File location

History is stored internally under the XDG data directory, not the config
directory.

Default location:

- `$XDG_DATA_HOME/corbits/history.jsonl`
- fallback: `~/.local/share/corbits/history.jsonl`

The file path stays internal in v1. Tests and internal helpers may inject an
alternate path without making that part of the public CLI surface.

### Format

The source of truth is an append-only JSONL file. Each successful paid call
adds one JSON object per line.

This is preferred over SQLite for v1 because it keeps writes simple, remains
easy to inspect manually, and is sufficient for in-process filtering.

### Record schema

Each history record stores normalized fields at write time to keep reads
predictable:

- `timestamp_ms`
- `tool`
- `method`
- `url`
- `host`
- `resource_path`
- `response_status`
- `payment_status`
- `amount`
- `asset`
- `network`
- `wallet_address`
- `wallet_kind`
- `tx_signature` when available

Optional field when `--save-response` is used:

- `response`

Notes:

- the canonical key for `show` is the 1-based line number in the JSONL file,
  displayed as `#` in listing output. `timestamp_ms` is used for sorting and
  time-range filtering only.
- the full URL is stored for exact audit/debug use
- host and resource path are stored separately for filtering and summaries
- concurrent `corbits call` invocations (e.g. from a shell script) may interleave
  appends. JSONL append is safe — individual JSON lines are written atomically at
  the OS level — but the ordering of concurrent entries is non-deterministic.
  Within a single process the append order matches execution order.

## Implementation Shape

### Write path

Extend the paid `call` flow so that, after a successful paid retry, the command
builds a normalized history record from data it already has:

- wrapped tool and parsed method
- final request URL
- active wallet and payment network from resolved config
- amount/asset/network from payment metadata
- tx signature when available from the settled payment response
- final response status from the paid retry result

If `--save-response` is present, the write path also captures and stores the
response body for the successful paid retry.

History persistence should be isolated behind a small module so the command
logic stays focused on request execution.

### Read path

`history` should:

1. open the JSONL file if it exists
2. stream or iterate line by line
3. parse valid JSON records
4. skip malformed lines defensively
5. normalize time filter input
6. apply filters
7. sort by `timestamp_ms` descending
8. render the requested output format

If the history file does not exist yet, the command should produce a clean empty
state rather than an error.

### Detail path

`history show <index>` should read line `<index>` from the JSONL file directly
by position (1-based). If the index is out of range or the line is malformed,
the command should return a clear not-found or parse error rather than guessing.

## Error Handling

- malformed JSONL lines should be skipped during reads instead of failing the
  entire command
- time filter parse errors should fail fast with a clear CLI error
- failed history writes should warn on stderr but must not turn a successful
  paid call into a failed command
- out-of-range or malformed index for `show` should return a clear not-found or parse error

## Testing

Add coverage for:

- successful paid call writes metadata history entry
- `--save-response` stores response data
- history write failure warns without changing paid call success behavior
- `history` default listing and sorting
- each filter type, including time filters
- accepted `--since` and `--until` inputs: Unix ms, Unix seconds, ISO datetime
- `history show <index>` for entries with and without saved response
- `history show` with an out-of-range index returns a clear not-found error
- `--save-response` on a streamed response warns and writes metadata only
- `--min-amount` and `--max-amount` filter on base integer units; display renders human-readable
- malformed JSONL lines are skipped during reads
- empty or missing history file produces a clean empty state

## Recommendation

Implement the feature as:

- append-only internal JSONL storage
- write-time normalization of record fields
- standalone `history` listing command
- `history show <index>` detail command using 1-based line position
- per-call response capture via `--save-response`

This keeps the first version operationally simple while leaving room to grow
into richer summaries or a different backing store later if usage demands it.
