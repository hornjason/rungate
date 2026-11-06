---
description: How to report a problem you found in rungate itself, from this repository
paths:
  - "package.json"
generated-sha: 42ccda079c16b378
---

## You found something in rungate, not in this project

File it on **hornjason/rungate**, not here, and not as a code comment that
nobody upstream reads.

```bash
gh issue create --repo hornjason/rungate \
  --label from-consumer \
  --title "<the symptom, not the fix>" \
  --body-file <a file you wrote FIRST, in a separate command>
```

## Show the body to your user before you send it

**hornjason/rungate is somebody else's repository, and its issues are
public.** Filing there publishes whatever you wrote, permanently — a
deletion later does not un-cache or un-index it. So the body is not yours to
send on your own judgement: write the file, show it to your user, and send
it only once they have said yes.

What goes in it is the **smallest thing that reproduces the problem**, and
nothing else:

- a reproducer you constructed, never a paste of this project's source,
  config, logs, stack traces, test output or data
- paths only where the path IS the symptom — and say so
- no credentials, tokens, keys, internal hostnames, URLs or customer data,
  including inside a quoted error message

If you cannot describe the problem without one of those, that is the thing
to tell your user. It is not a reason to send it anyway.

## The label is `from-consumer`, and it is not `external-audit`

`external-audit` means *rungate audited something else*. A consumer report
is the opposite direction, and conflating them is how a report from a real
user lands in a queue nobody triages as user feedback.

If `from-consumer` does not exist on the repository, say so in the body
rather than substituting the nearest label. A label chosen because it was
available is a routing decision nobody made.

## What the body must carry

The three sections every issue there needs. No criterion id — you cannot
know one from here and you are not expected to:

- **What must become true** — the symptom, with the numbers you measured
- **Files this will change** — if you know; *unknown* is an honest answer
- **How we will know** — what you would run to see it fixed

Say which version you are on: the `rungate` entry in your
`package.json`. A report against a version nobody can identify cannot be
reproduced, and will be closed as such.

## Do not open a pull request first

File the issue, link it, and wait for a reply. A pull request from a
consumer against a harness they do not own is expensive to review and
frequently solves the wrong half of the problem — the maintainers may
already know the cause.

## What belongs here instead

A problem in **this** project's own code, config or specs is an ordinary
issue on this repository. The test is simple: if deleting rungate would
make the problem go away it is upstream, and if it would not it is yours.
