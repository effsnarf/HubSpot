# API Test

## Task

I made some improvements to the code and added a method to process meetings but there
doesn't seem to be a `meetings` entity in the HubSpot CRM. I'm not sure if I'm doing
something wrong, I tried adding `meeting` entries to Domain.js but it doesn't work,
I tried connecting to the database with a MongoDB UI and I don't see any of the
entities (`companies`, `contacts`) at all.

# Improvements

## (1) code quality and readability

A lot of the code repeats common tasks like error handling, common database actions, etc.
It can be significantly compressed, made more readable, and less error-prone
by grouping these into utility functions. I restructured some of the more obvious offenders
(processEntities, tryOperation). Basically, there should be no code repetitions anywhere at all.

## (2) project architecture

Putting all kinds of unrelated methods like `generateLastModifiedDateFilter`, `saveDomain`,
`refreshAccessToken`, etc., in one large file may work for smaller tasks, but serious projects
should be highly structured with general-purpose classes encapsulating individual responsibilities,
such as an AccessToken class with token-related methods, and perhaps a Filter helper class
for creating filters, and so on.

As far as I can tell from worker.js, most of the work is simply data transformations.
Once a developer is familiar enough with the more common operations, a domain-specific language
or JSON format, or even some UI tool could be developed to define most of the
data transformation operations.

## (3) code performance

It really depends on the performance bottlenecks. In case data transformations are too slow,
the schema needs to be denormalized to gain performance in exchange for storage space.
If the bottlenecks are at the network, some message queuing could be used. If the sheer amounts
of data are the problem, some database replication can be set up, or making sure only
the bare minimum of actual changes are sent across the network.
