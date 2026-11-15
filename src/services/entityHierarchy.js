// Shared master-data hierarchy helpers for
//   Client -> Mine Site -> Plant -> Plant Section -> Equipment Tag
//
// Two problems this module exists to fix, both source-proven in
// AdminEntitiesTab.jsx and adminController.js before this change:
//
//   1. Every list/detail response returned only raw foreign-key ids
//      (client_id, mine_site_id, plant_id, plant_section_id) with no
//      readable name or parent context, so the Admin UI rendered ids like
//      "c_example_north" instead of "Example North Mining".
//   2. Create/update endpoints accepted any string as a parent id with no
//      existence or active-status check, so an orphan or inactive parent
//      link was trivially possible and silently accepted.
//
// "Active" here means the master-data record has not been archived through
// the generic deactivate/reactivate routes (see coreController.js). A
// missing `is_active` field is treated as active — some records seeded by
// store.js's seedData() predate this field (see normalizeDb's backfill) and
// must not be misread as disabled.
//
// Hierarchy integrity rules (Lane 6, Batch 1):
//
//   A. A record is never moved to a parent that belongs to a different client.
//      Every node in this chain is client-owned, so a cross-client move would
//      silently change who owns the whole subtree beneath it and leave quotes,
//      service requests and maintenance schedules that already link one of its
//      equipment tags pointing at another client's asset. Refused for every
//      level (mine site -> client, plant -> mine site, plant section -> plant,
//      equipment tag -> plant section). To "move" something between clients,
//      deactivate it and create a new record under the other client.
//
//      ORPHAN REPAIR: when the record's CURRENT parent chain cannot be resolved
//      to a client (the parent is missing, or an ancestor above it is), there
//      is no owning client to protect, so re-parenting it is allowed — this is
//      the only way to repair such a record. The NEW parent's chain must still
//      resolve to a client; otherwise the move is refused because its client
//      cannot be confirmed.
//
//   B. Equipment tag codes are unique per MINE SITE, ignoring letter case and
//      extra whitespace, and INCLUDING inactive tags (a retired code stays
//      reserved because historical documents still show it). The check runs
//      only when a tag is created, when its code actually changes, or when a
//      move puts it under a different mine site. Saving a legacy duplicate
//      without changing its code or mine site is never blocked, and legacy
//      tags whose chain cannot be resolved to a mine site are not matched.
//      Scope is the mine site (all plants and sections under it), NOT the
//      whole client, because ORAC has not confirmed a single client-wide
//      equipment-tag register. If ORAC confirms one, widen the scope in
//      mineSiteIdForPlantSection / findDuplicateTagCode (one place).

export function isRecordActive(record) {
  return Boolean(record) && record.is_active !== false;
}

export function findClient(db, id) {
  return id ? (db.clients || []).find((item) => item.id === id) || null : null;
}

export function findMineSite(db, id) {
  return id ? (db.mine_sites || []).find((item) => item.id === id) || null : null;
}

export function findPlant(db, id) {
  return id ? (db.plants || []).find((item) => item.id === id) || null : null;
}

export function findPlantSection(db, id) {
  return id ? (db.plant_sections || []).find((item) => item.id === id) || null : null;
}

export function findEquipmentTag(db, id) {
  return id ? (db.equipment_tags || []).find((item) => item.id === id) || null : null;
}

/** Ancestor chain for a mine site. */
export function mineSiteAncestors(db, mineSite) {
  const client = mineSite ? findClient(db, mineSite.client_id) : null;
  return { client };
}

/** Ancestor chain for a plant. */
export function plantAncestors(db, plant) {
  const mine_site = plant ? findMineSite(db, plant.mine_site_id) : null;
  const { client } = mineSiteAncestors(db, mine_site);
  return { mine_site, client };
}

/** Ancestor chain for a plant section. */
export function plantSectionAncestors(db, section) {
  const plant = section ? findPlant(db, section.plant_id) : null;
  const { mine_site, client } = plantAncestors(db, plant);
  return { plant, mine_site, client };
}

/** Ancestor chain for an equipment tag. */
export function equipmentTagAncestors(db, tag) {
  const plant_section = tag ? findPlantSection(db, tag.plant_section_id) : null;
  const { plant, mine_site, client } = plantSectionAncestors(db, plant_section);
  return { plant_section, plant, mine_site, client };
}

const ORPHAN_LABEL = "(missing parent — orphan link)";

function nameOf(record) {
  if (!record) return ORPHAN_LABEL;
  return record.name || record.tag_code || record.id;
}

function pathNode(type, record, fallbackId) {
  return {
    type,
    id: record?.id || fallbackId || null,
    name: nameOf(record),
    is_active: isRecordActive(record)
  };
}

function joinLabel(path) {
  return path.map((node) => node.name).join(" \u203a "); // "Client › Mine Site › ..."
}

/** Normalize a client for API responses. Clients have no parent. */
export function enrichClient(db, client) {
  if (!client) return client;
  const is_active = client.is_active !== false;
  const hierarchy_path = [pathNode("client", client)];
  return { ...client, is_active, hierarchy_path, hierarchy_label: joinLabel(hierarchy_path) };
}

/** Enrich a mine site with its client name and full breadcrumb. */
export function enrichMineSite(db, mineSite) {
  if (!mineSite) return mineSite;
  const { client } = mineSiteAncestors(db, mineSite);
  const is_active = mineSite.is_active !== false;
  const hierarchy_path = [
    pathNode("client", client, mineSite.client_id),
    pathNode("mine_site", { ...mineSite, is_active })
  ];
  return {
    ...mineSite,
    is_active,
    client_name: nameOf(client),
    client_is_active: isRecordActive(client),
    parent_orphaned: Boolean(mineSite.client_id) && !client,
    hierarchy_path,
    hierarchy_label: joinLabel(hierarchy_path)
  };
}

/** Enrich a plant with its mine site + client names and full breadcrumb. */
export function enrichPlant(db, plant) {
  if (!plant) return plant;
  const { mine_site, client } = plantAncestors(db, plant);
  const is_active = plant.is_active !== false;
  const hierarchy_path = [
    pathNode("client", client),
    pathNode("mine_site", mine_site, plant.mine_site_id),
    pathNode("plant", { ...plant, is_active })
  ];
  return {
    ...plant,
    is_active,
    mine_site_name: nameOf(mine_site),
    mine_site_is_active: isRecordActive(mine_site),
    client_name: nameOf(client),
    client_is_active: isRecordActive(client),
    parent_orphaned: Boolean(plant.mine_site_id) && !mine_site,
    hierarchy_path,
    hierarchy_label: joinLabel(hierarchy_path)
  };
}

/** Enrich a plant section with its plant/mine site/client names and full breadcrumb. */
export function enrichPlantSection(db, section) {
  if (!section) return section;
  const { plant, mine_site, client } = plantSectionAncestors(db, section);
  const is_active = section.is_active !== false;
  const hierarchy_path = [
    pathNode("client", client),
    pathNode("mine_site", mine_site),
    pathNode("plant", plant, section.plant_id),
    pathNode("plant_section", { ...section, is_active })
  ];
  return {
    ...section,
    is_active,
    plant_name: nameOf(plant),
    plant_is_active: isRecordActive(plant),
    mine_site_name: nameOf(mine_site),
    mine_site_is_active: isRecordActive(mine_site),
    client_name: nameOf(client),
    client_is_active: isRecordActive(client),
    parent_orphaned: Boolean(section.plant_id) && !plant,
    hierarchy_path,
    hierarchy_label: joinLabel(hierarchy_path)
  };
}

/** Enrich an equipment tag with its full ancestor names and breadcrumb. */
export function enrichEquipmentTag(db, tag) {
  if (!tag) return tag;
  const { plant_section, plant, mine_site, client } = equipmentTagAncestors(db, tag);
  const is_active = tag.is_active !== false;
  const hierarchy_path = [
    pathNode("client", client),
    pathNode("mine_site", mine_site),
    pathNode("plant", plant),
    pathNode("plant_section", plant_section, tag.plant_section_id),
    pathNode("equipment_tag", { ...tag, is_active, name: tag.tag_code })
  ];
  return {
    ...tag,
    is_active,
    plant_section_name: nameOf(plant_section),
    plant_section_is_active: isRecordActive(plant_section),
    plant_name: nameOf(plant),
    plant_is_active: isRecordActive(plant),
    mine_site_name: nameOf(mine_site),
    mine_site_is_active: isRecordActive(mine_site),
    client_name: nameOf(client),
    client_is_active: isRecordActive(client),
    parent_orphaned: Boolean(tag.plant_section_id) && !plant_section,
    hierarchy_path,
    hierarchy_label: joinLabel(hierarchy_path)
  };
}

// Collection name -> { lookup(db, parentId), parentNoun } used by
// validateParentAssignment below and reusable anywhere else that needs the
// same "what does this collection's parent field point at" mapping.
//
// `clientOf(db, parent)` resolves the owning client of a PARENT record found
// by `lookup` (null when its chain is broken), for the cross-client rule.
const PARENT_LOOKUPS = {
  mine_sites: { lookup: findClient, parentNoun: "client", clientOf: (db, client) => client },
  plants: { lookup: findMineSite, parentNoun: "mine site", clientOf: (db, site) => mineSiteAncestors(db, site).client },
  plant_sections: { lookup: findPlant, parentNoun: "plant", clientOf: (db, plant) => plantAncestors(db, plant).client },
  equipment_tags: { lookup: findPlantSection, parentNoun: "plant section", clientOf: (db, section) => plantSectionAncestors(db, section).client }
};

/**
 * Validate a parent-id assignment for one of the four hierarchy collections.
 *
 * - Referential integrity (the parent must exist) is enforced whenever
 *   `parentId` is provided at all, for both create and update.
 * - The "must be active" rule only applies to a *new* link: creating a
 *   record, or updating one to point at a different parent than it already
 *   had. Saving a record without touching its parent field never re-checks
 *   an already-existing (possibly now-inactive) link, so archiving a parent
 *   never silently breaks historical children — it only stops new children
 *   from being attached to it.
 * - Cross-client rule: when an UPDATE changes the parent (`previousParentId`
 *   given and different), the new parent must belong to the same client as
 *   the old one. See "Hierarchy integrity rules" at the top of this file,
 *   including the orphan-repair exception. Creates are unaffected.
 *
 * Returns { ok: true } or { ok: false, status, message }.
 */
export function validateParentAssignment(db, { collection, parentId, previousParentId }) {
  if (parentId === undefined) return { ok: true };

  const config = PARENT_LOOKUPS[collection];
  if (!config) return { ok: true };

  if (!parentId) {
    return { ok: false, status: 400, message: `A ${config.parentNoun} is required.` };
  }

  const parent = config.lookup(db, parentId);
  if (!parent) {
    return {
      ok: false,
      status: 400,
      message: `No ${config.parentNoun} exists with id "${parentId}". Choose an existing ${config.parentNoun} — this link would otherwise be an orphan.`
    };
  }

  const isNewLink = previousParentId === undefined || parentId !== previousParentId;

  // Cross-client rule. Only a MOVE is checked (a previous parent id exists and
  // differs); a record whose current chain resolves to no client is being
  // repaired and may be re-parented.
  if (isNewLink && previousParentId) {
    const previousParent = config.lookup(db, previousParentId);
    const previousClient = previousParent ? config.clientOf(db, previousParent) : null;
    if (previousClient) {
      const newClient = config.clientOf(db, parent);
      if (!newClient) {
        return {
          ok: false,
          status: 400,
          message: `"${nameOf(parent)}" is not linked to a complete client chain, so its client cannot be confirmed. Choose a ${config.parentNoun} that belongs to ${nameOf(previousClient)}.`
        };
      }
      if (newClient.id !== previousClient.id) {
        return {
          ok: false,
          status: 400,
          message: `"${nameOf(parent)}" belongs to a different client (${nameOf(newClient)}) than this record's current ${config.parentNoun} (${nameOf(previousClient)}). Records cannot be moved between clients — deactivate this one and create a new record under the other client instead.`
        };
      }
    }
  }

  if (isNewLink && !isRecordActive(parent)) {
    return {
      ok: false,
      status: 400,
      message: `"${nameOf(parent)}" is an inactive ${config.parentNoun} and cannot be assigned to a new or changed record. Reactivate it first, or choose an active ${config.parentNoun}. Existing links created before it was deactivated are not affected.`
    };
  }

  return { ok: true };
}

/**
 * Validate that a NEW (or changed) equipment-tag link on a record such as a
 * quote points at a usable tag for that record's client.
 *
 * This is the same rule two other flows already enforce — client service
 * requests (serviceRequestRules.resolveOwnedReferences: the whole chain must
 * be active and owned by the client) and maintenance schedules
 * (contractsController.equipmentTagProblem: tag must exist, be active and
 * belong to the contract's client). Quotes were the one flow that accepted
 * equipment_tag_id with no check, so a new quote could link a missing,
 * disabled, or another client's tag, and generated documents would print that
 * other client's site hierarchy.
 *
 * Callers must only invoke this when the link is being set or changed. Records
 * that already carry a tag keep it even after the tag (or a parent) is
 * disabled, so historical quotes, dispatches, Timesheets and documents never
 * lose their links.
 *
 * Returns { ok: true } or { ok: false, status, message }.
 */
export function validateEquipmentTagForClient(db, { tagId, clientId }) {
  if (!tagId) return { ok: true };

  const tag = findEquipmentTag(db, tagId);
  if (!tag) {
    return { ok: false, status: 400, message: `No equipment tag exists with id "${tagId}".` };
  }

  const { plant_section, plant, mine_site } = equipmentTagAncestors(db, tag);
  if (!plant_section || !plant || !mine_site) {
    return {
      ok: false,
      status: 400,
      message: `Equipment tag "${nameOf(tag)}" is not linked to a complete Plant Section > Plant > Mine Site chain, so its client cannot be confirmed.`
    };
  }

  if (mine_site.client_id !== clientId) {
    return {
      ok: false,
      status: 400,
      message: `Equipment tag "${nameOf(tag)}" belongs to a different client and cannot be linked here.`
    };
  }

  const inactive = [
    ["equipment tag", tag],
    ["plant section", plant_section],
    ["plant", plant],
    ["mine site", mine_site]
  ].find(([, record]) => !isRecordActive(record));
  if (inactive) {
    const reason = inactive[1] === tag
      ? `is inactive`
      : `cannot be linked to a new record because its ${inactive[0]} "${nameOf(inactive[1])}" is inactive`;
    return {
      ok: false,
      status: 400,
      message: `Equipment tag "${nameOf(tag)}" ${reason}. Existing records that already use it are not affected.`
    };
  }

  return { ok: true };
}

/**
 * Canonical form of an equipment tag code for uniqueness comparison: all runs
 * of whitespace (including non-breaking spaces) collapse to one space, ends are
 * trimmed, and letter case is ignored. Only used to COMPARE — stored codes are
 * never rewritten.
 */
export function normaliseTagCode(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Owning mine site id of a plant section (section -> plant -> mine site), or
 * null when the plant or mine site link is missing. A missing client above the
 * mine site does not matter for this scope.
 */
export function mineSiteIdForPlantSection(db, plantSectionId) {
  const { mine_site } = plantSectionAncestors(db, findPlantSection(db, plantSectionId));
  return mine_site ? mine_site.id : null;
}

/**
 * Find another equipment tag of the same mine site whose code matches `tagCode`
 * after normalisation. Inactive tags count. `excludeId` skips the tag being
 * edited. Tags whose own chain cannot be resolved to a mine site are not
 * matched (their site is unknown). If the target section's chain cannot be
 * resolved either, the comparison falls back to tags in that same plant section.
 * Returns the conflicting tag record or null.
 */
export function findDuplicateTagCode(db, { tagCode, plantSectionId, excludeId } = {}) {
  const wanted = normaliseTagCode(tagCode);
  if (!wanted) return null;

  const mineSiteId = mineSiteIdForPlantSection(db, plantSectionId);
  for (const tag of db.equipment_tags || []) {
    if (excludeId !== undefined && tag.id === excludeId) continue;
    if (normaliseTagCode(tag.tag_code) !== wanted) continue;
    if (mineSiteId) {
      if (mineSiteIdForPlantSection(db, tag.plant_section_id) === mineSiteId) return tag;
    } else if (tag.plant_section_id === plantSectionId) {
      return tag;
    }
  }
  return null;
}

/**
 * Validate that `tagCode` is not already used by another tag of the same
 * mine site (see findDuplicateTagCode). Returns { ok: true } or
 * { ok: false, status: 409, message }.
 */
export function validateTagCodeUnique(db, { tagCode, plantSectionId, excludeId } = {}) {
  const clash = findDuplicateTagCode(db, { tagCode, plantSectionId, excludeId });
  if (!clash) return { ok: true };
  const status = isRecordActive(clash) ? "" : " (inactive)";
  return {
    ok: false,
    status: 409,
    message: `Equipment tag code "${String(tagCode).trim()}" is already used by "${clash.tag_code}"${status} for this mine site. Tag codes must be unique per mine site, ignoring capital letters and extra spaces.`
  };
}
