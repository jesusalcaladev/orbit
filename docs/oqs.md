# OQS — Orbit Query Syntax

OQS is the query language of Orbit. It is deliberately minimal and **explicit**: there is no magic inference. Everything the server needs is either in the query string or in the registered plugins/adapters.

## Grammar

```
query  := entity [ "{" fields "}" ]
entity := IDENT [ "(" args ")" ]
args   := kv ( "," kv )*
kv     := IDENT "=" value
value  := STRING | BARE          # both passed verbatim to adapters
fields := item ( "," item )*
item   := IDENT [ "(" args ")" ] [ "{" fields "}" ]
```

Whitespace is ignored anywhere except inside quoted values.

### Identifiers

Entity and field names start with a letter or `_` and may contain letters, digits, `_`, `-` and `.`:

```
user { first-name, profile.image }
```

### Values — always verbatim strings

The framework never interprets `id` as a primary key or `username` as a unique constraint. Every value is delivered to the adapter **exactly as written**, as a string:

```ts
// OQS:  posts(id=42, status="a b")
// filters delivered to the adapter:
{ id: '42', status: 'a b' }
```

- Quoted values (`"..."` or `'...'`) support escapes: `\"`, `\'`, `\\`, `\n`, `\t`, `\r`.
- Bare values (unquoted) run until whitespace or one of `,(){}="'`.
- `"00123"` stays `"00123"` — leading zeros are preserved.

## Examples

### Single entity, some fields

```
user(id="123") { name, email }
```

### Nested relations

```
user(id="123") {
  name,
  posts(status="published") { title, views }
}
```

Each relation is resolved **per parent**: while the `posts` adapter runs, `ctx.parent` carries the resolved parent record, so the adapter can scope the query (`WHERE author_id = <parent.id>`).

### Relations without filters or fields

```
user(id="1") { posts }          # relation, no selection → raw adapter result
user(id="1") { posts { id } }   # relation, no filters
```

### Roots without braces

```
user(id="1")
```

When nothing is selected, the adapter's result is returned **as-is** (no projection).

## Semantics

| Construct | Adapter receives |
| :--- | :--- |
| `user(id="123")` | `resolve({ id: "123" }, ctx)` |
| `user { name }` | `resolve({}, ctx)` → projected to `{ name }` |
| `user { posts { title } }` | per parent: `resolve({}, { parent })` → projected per post |
| Many parents | sibling requests of the same entity are grouped into one `batch()` call |

### Projection rules

- Only the requested leaf fields are kept.
- Arrays are projected item-by-item.
- A node with **no fields and no relations** returns the whole value.
- A relation result of `undefined` is omitted from the parent object; `null` and `[]` are kept.

## Depth limits

Nesting is capped (default `10`, configurable via `maxQueryDepth`). Deeper trees fail fast with `ORBIT_MAX_DEPTH_EXCEEDED` — this protects the engine from pathological queries.

```ts
createOrbit({ maxQueryDepth: 5 });
```

## Error cases

| Query | Error |
| :--- | :--- |
| `''` | `ORBIT_INVALID_QUERY` — query is empty |
| `user(id="1'` | `ORBIT_INVALID_QUERY` — unterminated string |
| `user { name` | `ORBIT_INVALID_QUERY` — unterminated block |
| `user(id 1)` | `ORBIT_INVALID_QUERY` — expected `=` |
| `user(id="1") trailing` | `ORBIT_INVALID_QUERY` — trailing input |
| 11 levels deep (default) | `ORBIT_MAX_DEPTH_EXCEEDED` |

Syntax errors always carry `details.position` for precise client-side feedback.

## Mutations

Mutations live in the envelope, not in the query string:

```json
{
  "do": "user.update",
  "args": {
    "filter": { "id": "123" },
    "payload": { "name": "Ana" }
  },
  "return": "user(id=\"123\") { name, email }"
}
```

- `do` is `entity.action`; the adapter's `mutate(action, args, ctx)` runs.
- `filter` and `payload` are passed **verbatim**.
- `return` is a normal OQS string, resolved **after** the mutation (nodes are stamped `origin: 'mutate'`).
- Without `return`, the response is `{ "data": { "success": true, "id": "123" }, "invalidates": [...] }`.
