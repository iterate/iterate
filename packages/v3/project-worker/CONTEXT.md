# Iterate control plane

Vocabulary for the proposed control-plane model, including identities used by
humans and automation. This glossary does not imply those records exist today.

## Language

**Principal**:
A stable identity that can act in Iterate: a human, service account or built-in
platform identity. Its identity survives individual credentials and connections.
_Avoid_: User when non-human identities are included, token, permission set

**Credential**:
Evidence accepted to authenticate as a Principal. Distinct credentials can
identify the same Principal while imposing different restrictions.
_Avoid_: Principal, actor

**Authorization**:
The effective permission of authenticated access, constrained by its credential,
grant and applicable current policy.
_Avoid_: Identity, account state

**Actor**:
The Principal performing a particular action. An action's target and any
Principal represented through delegation are separate from its Actor.
_Avoid_: Target context, credential creator

**Principal context**:
The named context representing a Principal and holding its domain history and
state. Different authenticated access to it can carry different Authorization.
_Avoid_: Login session, API key

**Session**:
Authenticated access by a Principal, providing authorized project selection and
access to the user's context. A Session is distinct from a Principal context.
_Avoid_: IterateContext, user stream

**Project confinement**:
Execution within a project can access only that project's namespace, whether
triggered by a caller, processor or alarm. A caller's wider permissions do not
extend that execution's reach.
_Avoid_: Ambient user grant, cross-project context traversal

**Delegation**:
Authority for one Principal to act on behalf of another while preserving both
identities in attribution.
_Avoid_: Replacing the actor with the represented user

**Audit record**:
A trusted record of an operation's attribution, target and outcome, including
links to its initiating action when applicable.
_Avoid_: Client-supplied attribution, activity feed alone
