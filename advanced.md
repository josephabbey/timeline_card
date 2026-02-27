# Advanced Configuration

This document covers advanced YAML-only configuration options for the Location Timeline Card. These options are not available through the GUI editor — switch to the YAML editor to use them.

## Entity object syntax

Each item in the `entity` list can be a plain string (entity ID) or an object. The object form lets you attach an `activity_entity` or `places_entity` directly to a specific tracked entity.

### Object properties

| Property | Required | Description |
|---|---|---|
| `entity` | **Yes** | The `device_tracker` or `person` entity ID. |
| `activity_entity` | No | A `sensor` entity that tracks the current activity (e.g. walking, running, cycling). When set, move segments display the resolved activity name instead of "Moving". |
| `places_entity` | No | A `sensor` entity from the [Places integration](https://github.com/custom-components/places). Takes precedence over the top-level `places_entity` for this entity. |

### Examples

**Simple — all entities as strings (works in GUI and YAML):**
```yaml
type: custom:location-timeline-card
entity:
  - person.alice
  - person.bob
```

**Object form — per-entity activity and places sensors:**
```yaml
type: custom:location-timeline-card
entity:
  - entity: person.alice
    activity_entity: sensor.alice_activity
    places_entity: sensor.places_alice
  - entity: person.bob
    activity_entity: sensor.bob_activity
    places_entity: sensor.places_bob
```

**Mixed — strings and objects together:**
```yaml
type: custom:location-timeline-card
entity:
  - person.alice
  - entity: person.bob
    activity_entity: sensor.bob_activity
```

### How `places_entity` resolution works

1. **Per-entity override** — If a `places_entity` is specified in the entity object, it is used directly for that entity.
2. **Top-level fallback** — If not specified per-entity, the card checks the top-level `places_entity` list and auto-matches by the `devicetracker_entityid` attribute on the Places sensor.

This means you can mix both approaches:
```yaml
type: custom:location-timeline-card
entity:
  - entity: person.alice
    places_entity: sensor.places_alice
  - person.bob
places_entity:
  - sensor.places_bob
```

### GUI editor behavior

When entity objects are detected in the configuration, the GUI editor is automatically disabled and the card switches to YAML mode. To return to the GUI editor, convert all entity items back to plain strings and configure `places_entity` / `activity_entity` separately or remove them.
