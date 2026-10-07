# [@netiflyjs/client-v2.0.0](https://github.com/NetiflyJS/netifly/compare/@netiflyjs/client-v1.1.0...@netiflyjs/client-v2.0.0) (2026-10-07)


### Bug Fixes

* address final-review findings (NOT-38) ([52c9726](https://github.com/NetiflyJS/netifly/commit/52c9726c4e1967090a179d9fa1cf39b30afb218d))
* **core:** address final review findings — link-safety bypass, schema/runtime drift, icon/expiresAt/meta validation, client docs (NOT-37) ([24fc12a](https://github.com/NetiflyJS/netifly/commit/24fc12a0b409ae391ad8057e93fb95e1a814fe9a))


### Features

* **client:** add respondToAction()/onActionAck()/onResolved() (NOT-38) ([7c6c1b8](https://github.com/NetiflyJS/netifly/commit/7c6c1b81bf0b062bf1576951b3968ff86ce7baac))
* **core:** actionable notifications — verified answers, 'action' event, resolved relay (NOT-38) ([60617cd](https://github.com/NetiflyJS/netifly/commit/60617cd79e2b4e92ad2fe4fd5d9689254bc7669d))


### BREAKING CHANGES

* **core:** createNetifly()/createNetiflyPublisher() now throw at
construction unless actionSecret or NETIFLY_SECRET is set, or
actionSecret: false is passed explicitly.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

# [@netiflyjs/client-v1.1.0](https://github.com/NetiflyJS/netifly/compare/@netiflyjs/client-v1.0.0...@netiflyjs/client-v1.1.0) (2026-09-28)


### Bug Fixes

* **client:** don't let netifly.* relay echoes overwrite lastEventId ([239638f](https://github.com/NetiflyJS/netifly/commit/239638fdd654848825dea4360e173824ad90a429))


### Features

* **client:** add markRead(), respond(), and auto-ack (NOT-30) ([c336e9b](https://github.com/NetiflyJS/netifly/commit/c336e9b63f6a9b1e4f38398ebe9d1b7a776bb793))

# @netiflyjs/client-v1.0.0 (2026-09-27)


### Bug Fixes

* **client:** retry when a handshake fails with no close event ([0f874d2](https://github.com/NetiflyJS/netifly/commit/0f874d2860b2b1471d8897f7eb06c0e0aa573eda))


### Features

* **client:** add @netiflyjs/client SDK with reconnect and typed events ([fbe1bef](https://github.com/NetiflyJS/netifly/commit/fbe1bef0636b7ad2bcc208345abf9808a76525ef))
