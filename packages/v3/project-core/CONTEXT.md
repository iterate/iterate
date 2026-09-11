# Iterate project

A project is a space of named resources and the authority to use them. This
glossary describes the domain, not which proposed resources are implemented.

## Language

**Artifact**:
A Cloudflare Artifacts hosted Git repository. This term is reserved for that
product concept, never a compiled bundle, build result, snapshot, or report.
_Avoid_: Build artifact, generic artifact

**Repo**:
A project-facing versioned collection of files with commits. It can present a
lightweight interface over a Cloudflare Artifact without sharing its API shape.
_Avoid_: Bundle cache

**Build output**:
The modules, assets and diagnostics derived from pinned source and build inputs.
The executable files form a bundle; they are not a Cloudflare Artifact.
_Avoid_: Artifact

**Project resource**:
A named thing within a project, such as a document, repository, worker or
secret. Its path does not imply that it is a byte file or a separate context.
_Avoid_: Actor, context when only a resource is meant

**Project path**:
A slash-prefixed name for a resource within one project, like a file path.
It resolves in the current namespace; knowing it grants neither permission nor
an immutable historical identity.
_Avoid_: Actor ID, capability token

**Resource handle**:
Authority to use specified operations on an opened project resource. It is
distinct from the path used to obtain it and does not silently follow replacement
of that path with a different resource.
_Avoid_: Path, saved reference

**Context**:
A named scope within a project that owns an ordered event history and its
associated state. Not every named resource is a separate context.
_Avoid_: File, worker

**Stream**:
The ordered history of events accepted by a context. Its offsets identify
positions within that history, not across the whole project.
_Avoid_: Live subscription

**Fetch policy**:
One function and one set of rules for HTTP requests. It decides how to handle
an internal or external destination; arriving from outside or originating in a
worker does not select a separate routing system.
_Avoid_: Separate ingress and egress policies

**Event provenance**:
Claims and evidence about an event's origin and causal inputs. A signature
attests a particular claim; multiple signatures may attest the same claim.
_Avoid_: Signature alone

**Event receipt**:
The platform's record of accepting an event, including its position and the
verification result under the policy in effect then.
_Avoid_: Producer claim

**Resource revision**:
A particular historical version of a resource, distinct from its current
project path. A name alone does not select immutable content.
_Avoid_: Current path
