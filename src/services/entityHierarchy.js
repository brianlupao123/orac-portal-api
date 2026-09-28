// Shared master-data hierarchy helpers for
//   Client -> Mine Site -> Plant -> Plant Section -> Equipment Tag
//
// Two problems this module exists to fix, both source-proven in
// AdminEntitiesTab.jsx and adminController.js before this change:
//
//   1. Every list/detail response returned only raw foreign-key ids
//      (client_id, mine_site_id, plant_id, plant_section_id) with no
//      readable name or parent context, so the Admin UI rendered ids like
//      "c_zimplats" instead of "Zimplats".
//   2. Create/update endpoints accepted any string as a parent id with no
//      existence or active-status check, so an orphan or inactive parent
//      link was trivially possible and silently accepted.
//
// "Active" here means the master-data record has not been archived through
// the generic deactivate/reactivate routes (see coreController.js). A
// missing `is_active` field is treated as active — some records seeded by
// store.js's seedData() predate this field (see normalizeDb's backfill) and
// must not be misread as disabled.

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
const PARENT_LOOKUPS = {
  mine_sites: { lookup: findClient, parentNoun: "client" },
  plants: { lookup: findMineSite, parentNoun: "mine site" },
  plant_sections: { lookup: findPlant, parentNoun: "plant" },
  equipment_tags: { lookup: findPlantSection, parentNoun: "plant section" }
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
