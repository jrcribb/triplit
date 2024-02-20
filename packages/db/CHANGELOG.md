# @triplit/db

## 0.3.18

### Patch Changes

- 9651552: add support for nullable sets
- 9a7fe03: add support for additive query filters and order statements in the query builder api
- 5ea23b8: ensure object assignments are agnostic to order
- 480f8eb: Add error and ts preventing updates to an entity id

## 0.3.17

### Patch Changes

- 458fc03: Fixup issues with set values in filters
- 10bb3eb: Add more informative errors when parsing values to types

## 0.3.16

### Patch Changes

- 6bf47f6: pass deleted keys to variables in exists subquery
- 3fe5761: Add fallback prop to TriplitErrors for identification

## 0.3.15

### Patch Changes

- 554aaa6: Implement basic json to js conversion of queries

## 0.3.14

### Patch Changes

- 33cc09c: refactor state vector querying, handle many async schema loads, fixup set filter bug with deleted entities

## 0.3.13

### Patch Changes

- 78edb1d: Improve error messaging
- 0bd7759: Improve indexeddb performance and prevent ghost attributes from deleted entities

## 0.3.12

### Patch Changes

- f2b0f1f: remove FormatRegistry usage in date

## 0.3.11

### Patch Changes

- 9e222c8: ensure clear() resets in memory schema
  small bug fixes
- ed225fd: Fix bug causing oversending of triples

## 0.3.10

### Patch Changes

- ae9bad9: clean up @tuple-database deps to fixt nextjs builds

## 0.3.9

### Patch Changes

- ff3bfe2: Properly handle single relationship deserialization

## 0.3.8

### Patch Changes

- f4f87df: Add RelationMany, RelationOne and RelationById schema helpers

## 0.3.7

### Patch Changes

- 4d2d381: add relationship types to schema

## 0.3.6

### Patch Changes

- 8edd13f: properly prune internal attributes on fetch

## 0.3.5

### Patch Changes

- 91ee2eb: dont return internal attributes from fetch

## 0.3.4

### Patch Changes

- 0d95347: add listener api for schema changes
- 0d95347: remove parcel dependency

## 0.3.3

### Patch Changes

- 5398d8d: build esm only, fixup entry point resolution

## 0.3.2

### Patch Changes

- 817e4cd: export update proxy methods

## 0.3.1

### Patch Changes

- 76c9700: Improve performance and support RSA-signed tokens

## 0.3.0

### Minor Changes

- 4af4fde: Add selecting subqueries and improve insert performance

## 0.2.3

### Patch Changes

- 06636a7: Fix CLI missing dependency issue

## 0.2.2

### Patch Changes

- d92db2c: fixup authentication variable handling
- d92db2c: drop automatic garbage collection

## 0.2.1

### Patch Changes

- 56d80f1: - rename MissingAttributeDefinitionError to TypeJSONParseError
  - refactor createCollection to handle rules

## 0.2.0

### Minor Changes

- 61455a2: minor version bump

## 0.1.1

### Patch Changes

- 6a92bbe: Fix Storage type error and include indexeddb dependency

## 0.1.0

### Minor Changes

- 2f75a31: bump version for beta release

## 0.0.39

### Patch Changes

- 1bb02af: version bump test

## 0.0.38

### Patch Changes

- 8761ebe: Many changes, bump version in prep for beta release

## 0.0.37

### Patch Changes

- af14ded: - Add support for date type
  - Support deeply nested updates and migrations
  - Allow additional data type options (nullable, default)
- af14ded: - Add fetch policy options
  - Bug fixes
  - Performance improvements

## 0.0.36

### Patch Changes

- 6df3de6: Update CLI to support HTTPS

## 0.0.32

### Patch Changes

- ba38c67: - fixup builds and typescript support
  - improve support for next.js

## 0.0.31

### Patch Changes

- 3145915: downgrade nanoid version

## 0.0.30

### Patch Changes

- 1a8f596: - Include the DB constructor as a default export
- 33a1201: Return transaction ids from update methods if an id is assigned
- 30aadee: - add rules and variables for authenticationa and authorization
  - Auto disconnect query on syncing error
  - Upgrade update api to immer style updates

## 0.0.28

### Patch Changes

- 5011219: - add string comparison operations
  - add fetchById method
  - support cursor pagination
  - performance improvements and bug fixes
