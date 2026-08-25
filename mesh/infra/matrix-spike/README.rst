Disposable Matrix federation test rig
======================================

This directory contains a throwaway local integration-test rig. It never faces
a Mesh user, is not a deployment reference, and must not be exposed to a public
network or retain real account data.

The Nginx and Synapse images are published upstream. Mesh does not operate or
patch them. Their findings remain visible in container scan evidence, but a
successful test cycle is not evidence that either image is suitable for a live
service. Delete the generated runtime after each test cycle and use the
separate community-hosting review before deploying any service for users.
