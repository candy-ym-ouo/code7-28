import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { createFeatureSchema } from "@map/shared/contracts";
import { query, transaction } from "../db";
import { AppError, conflict, forbidden, notFound } from "../errors";
import { optionalAuth, requireAuth, requireVerifiedContributor } from "../auth";
import { deleteObject, publicMediaUrl } from "../storage";
import { config } from "../config";
import { recordAudit } from "../audit";

type MediaRow = {
  id: string;
  privacy_status: string;
  public_object_key: string | null;
  public_thumbnail_object_key: string | null;
};

const EDITABLE_REVISION_STATUSES = ["draft", "rejected", "changes_requested"] as const;
const MEDIA_SELECT_COLUMNS = `
  jsonb_agg(jsonb_build_object(
    'id', ma.id,
    'privacy_status', ma.privacy_status,
    'public_object_key', ma.public_object_key,
    'public_thumbnail_object_key', ma.public_thumbnail_object_key
  )) ORDER BY rm.sort_order`;

function serializeMedia(media: MediaRow[] | null | undefined) {
  return (media ?? []).map((item) => ({
    id: item.id,
    status: item.privacy_status,
    url: publicMediaUrl(item.public_object_key),
    thumbnailUrl: publicMediaUrl(item.public_thumbnail_object_key)
  }));
}

function payloadWithDate(input: z.infer<typeof createFeatureSchema>) {
  return {
    ...input,
    observedAt: input.observedAt.toISOString()
  };
}

async function assertMediaUsable(client: PoolClient, ownerId: string, mediaIds: string[]) {
  if (mediaIds.length === 0) return;
  const result = await client.query<{ id: string; privacy_status: string }>(
    `SELECT id, privacy_status FROM media_assets
     WHERE id = ANY($1::uuid[]) AND owner_id = $2 AND deleted_at IS NULL`,
    [mediaIds, ownerId]
  );
  if (result.rowCount !== mediaIds.length) throw new AppError(400, "VALIDATION_FAILED", "One or more media items do not belong to this account");
  const invalid = result.rows.find((row) => !["ready", "manual_review"].includes(row.privacy_status));
  if (invalid) throw new AppError(409, "MEDIA_NOT_READY", "All media must finish privacy processing before submission", { mediaStatus: invalid.privacy_status });
}

/**
 * Replace the media bindings of one revision.
 *
 * Boundaries:
 * - Only the join rows of THIS revision are touched. Media still referenced by
 *   the published revision (or any other revision) stays bound there.
 * - Media that becomes fully unbound is not deleted: it remains owned by the
 *   contributor so a rejected draft can re-attach it. detach_reason records
 *   why the binding went away for audit/recovery.
 * - Re-attaching clears the detach marker.
 */
async function replaceRevisionMedia(client: PoolClient, revisionId: string, mediaIds: string[]) {
  const detached = await client.query<{ media_id: string }>(
    `DELETE FROM revision_media
     WHERE revision_id = $1 AND NOT (media_id = ANY($2::uuid[]))
     RETURNING media_id`,
    [revisionId, mediaIds]
  );
  for (const [index, mediaId] of mediaIds.entries()) {
    await client.query(
      `INSERT INTO revision_media(revision_id, media_id, sort_order)
       VALUES ($1, $2, $3)
       ON CONFLICT (revision_id, media_id) DO UPDATE SET sort_order = EXCLUDED.sort_order`,
      [revisionId, mediaId, index]
    );
  }
  if (mediaIds.length) {
    await client.query(
      "UPDATE media_assets SET detach_reason = NULL, updated_at = now() WHERE id = ANY($1::uuid[])",
      [mediaIds]
    );
  }
  const detachedIds = detached.rows.map((row) => row.media_id);
  if (detachedIds.length) {
    await client.query(
      `UPDATE media_assets ma
       SET detach_reason = 'revision_edited', updated_at = now()
       WHERE ma.id = ANY($1::uuid[])
         AND NOT EXISTS (SELECT 1 FROM revision_media rm WHERE rm.media_id = ma.id)`,
      [detachedIds]
    );
  }
}

function bboxFromString(value: string): [number, number, number, number] {
  const parts = value.split(",").map(Number);
  if (parts.length !== 4 || parts.some((item) => !Number.isFinite(item))) {
    throw new AppError(400, "VALIDATION_FAILED", "bbox must contain four numbers");
  }
  const [minLon, minLat, maxLon, maxLat] = parts as [number, number, number, number];
  if (minLon === maxLon || minLat >= maxLat) throw new AppError(400, "VALIDATION_FAILED", "Invalid bbox order");
  if (minLon < -180 || maxLon > 180 || minLat < -90 || maxLat > 90) {
    throw new AppError(400, "VALIDATION_FAILED", "bbox is outside valid longitude/latitude ranges");
  }
  const longitudeSpan = minLon > maxLon ? 360 - minLon + maxLon : maxLon - minLon;
  if (longitudeSpan > 5 || maxLat - minLat > 5) throw new AppError(400, "VALIDATION_FAILED", "bbox is too large");
  return [minLon, minLat, maxLon, maxLat];
}

export async function featureRoutes(app: FastifyInstance) {
  app.get("/categories", async () => {
    const result = await query(
      `SELECT key, name, icon, detail_schema, detail_schema_version, sort_order
       FROM categories WHERE is_active = true ORDER BY sort_order, key`
    );
    return result.rows;
  });

  app.get("/features", async (request) => {
    const input = z.object({
      bbox: z.string(),
      category: z.string().optional(),
      condition: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(250)
    }).parse(request.query);

    const [minLon, minLat, maxLon, maxLat] = bboxFromString(input.bbox);
    const categories = input.category?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
    const values: unknown[] = [minLon, minLat, maxLon, maxLat, input.limit];
    const conditions = [
      "mf.status = 'published'",
      "mf.deleted_at IS NULL"
    ];
    if (minLon > maxLon) {
      conditions.push(`(
        ST_Intersects(mf.geom, ST_SetSRID(ST_MakeEnvelope($1, $2, 180, $4), 4326)::geography)
        OR ST_Intersects(mf.geom, ST_SetSRID(ST_MakeEnvelope(-180, $2, $3, $4), 4326)::geography)
      )`);
    } else {
      conditions.push("ST_Intersects(mf.geom, ST_SetSRID(ST_MakeEnvelope($1, $2, $3, $4), 4326)::geography)");
    }

    if (categories.length) {
      values.push(categories);
      conditions.push(`mf.category_key = ANY($${values.length}::text[])`);
    }
    if (input.condition) {
      values.push(input.condition);
      conditions.push(`fr.payload->>'condition' = $${values.length}`);
    }

    const result = await query(
      `SELECT
         mf.id,
         mf.category_key,
         mf.status,
         mf.first_published_at,
         mf.freshness_expires_at,
         mf.needs_review_at,
         mf.updated_at,
         ST_X(mf.geom::geometry) AS longitude,
         ST_Y(mf.geom::geometry) AS latitude,
         c.name AS category_name,
         c.icon AS category_icon,
         fr.id AS revision_id,
         fr.payload,
         COALESCE(
           jsonb_agg(DISTINCT jsonb_build_object(
             'id', ma.id,
             'privacy_status', ma.privacy_status,
             'public_object_key', ma.public_object_key,
             'public_thumbnail_object_key', ma.public_thumbnail_object_key
           )) FILTER (WHERE ma.id IS NOT NULL),
           '[]'::jsonb
         ) AS media
       FROM map_features mf
       JOIN categories c ON c.key = mf.category_key
       JOIN feature_revisions fr ON fr.id = mf.current_revision_id
       LEFT JOIN revision_media rm ON rm.revision_id = fr.id
       LEFT JOIN media_assets ma ON ma.id = rm.media_id AND ma.deleted_at IS NULL
       WHERE ${conditions.join(" AND ")}
       GROUP BY mf.id, c.name, c.icon, fr.id
       ORDER BY mf.updated_at DESC
       LIMIT $5`,
      values
    );

    return result.rows.map((row) => ({
      id: row.id,
      categoryKey: row.category_key,
      categoryName: row.category_name,
      categoryIcon: row.category_icon,
      status: row.status,
      firstPublishedAt: row.first_published_at,
      freshnessExpiresAt: row.freshness_expires_at,
      needsReviewAt: row.needs_review_at,
      updatedAt: row.updated_at,
      longitude: Number(row.longitude),
      latitude: Number(row.latitude),
      title: row.payload.title,
      description: row.payload.description,
      condition: row.payload.condition,
      details: row.payload.details,
      tags: row.payload.tags,
      media: serializeMedia(row.media)
    }));
  });

  app.get("/features/:id", { preHandler: optionalAuth }, async (request) => {
    const input = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await query(
      `SELECT
         mf.id, mf.owner_id, mf.category_key, mf.status, mf.location_accuracy_m,
         mf.current_revision_id, mf.draft_revision_id,
         mf.first_published_at, mf.freshness_expires_at, mf.needs_review_at,
         mf.created_at, mf.updated_at, mf.deleted_at,
         ST_X(mf.geom::geometry) AS longitude,
         ST_Y(mf.geom::geometry) AS latitude,
         c.name AS category_name, c.icon AS category_icon,
         cur.id AS current_revision_row_id, cur.payload AS current_payload,
         cur_media.media AS current_media,
         dr.id AS draft_revision_row_id, dr.revision_no AS draft_revision_no,
         dr.status AS draft_revision_status, dr.payload AS draft_payload,
         dr.rejection_reason_code AS draft_reason_code,
         dr.moderation_notes AS draft_moderation_notes,
         dr.submitted_at AS draft_submitted_at,
         dr_media.media AS draft_media
       FROM map_features mf
       JOIN categories c ON c.key = mf.category_key
       LEFT JOIN feature_revisions cur ON cur.id = mf.current_revision_id
       LEFT JOIN feature_revisions dr ON dr.id = mf.draft_revision_id
       LEFT JOIN LATERAL (
         SELECT ${MEDIA_SELECT_COLUMNS} AS media
         FROM revision_media rm
         JOIN media_assets ma ON ma.id = rm.media_id AND ma.deleted_at IS NULL
         WHERE rm.revision_id = cur.id
       ) cur_media ON true
       LEFT JOIN LATERAL (
         SELECT ${MEDIA_SELECT_COLUMNS} AS media
         FROM revision_media rm
         JOIN media_assets ma ON ma.id = rm.media_id AND ma.deleted_at IS NULL
         WHERE rm.revision_id = dr.id
       ) dr_media ON true
       WHERE mf.id = $1`,
      [input.id]
    );
    const row = result.rows[0];
    if (!row || row.deleted_at) throw notFound("Feature not found");
    const canInspectPrivate = request.user && (request.user.id === row.owner_id || ["moderator", "admin"].includes(request.user.role));
    if (row.status !== "published" && !canInspectPrivate) throw notFound("Feature not found");

    // The base response always describes the publicly visible revision. For
    // never-published features there is no public revision yet, so the draft
    // payload is the only content available and only owners/moderators reach
    // this branch.
    const publicPayload = row.current_payload ?? row.draft_payload;
    const publicMedia = row.current_payload ? row.current_media : row.draft_media;

    const confirmations = await query(
      `SELECT result, count(*)::int AS count
       FROM feature_confirmations
       WHERE feature_id = $1 AND created_at > now() - interval '180 days'
       GROUP BY result`,
      [input.id]
    );

    const response: Record<string, unknown> = {
      id: row.id,
      ownerId: row.owner_id,
      categoryKey: row.category_key,
      categoryName: row.category_name,
      categoryIcon: row.category_icon,
      status: row.status,
      longitude: Number(row.longitude),
      latitude: Number(row.latitude),
      locationAccuracyM: row.location_accuracy_m,
      currentRevisionId: row.current_revision_id,
      firstPublishedAt: row.first_published_at,
      freshnessExpiresAt: row.freshness_expires_at,
      needsReviewAt: row.needs_review_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...publicPayload,
      media: serializeMedia(publicMedia ?? []),
      confirmations: confirmations.rows,
      draft: null
    };

    // The in-flight draft/revision is exposed only to the owner and reviewers,
    // independently of the public payload, so a rejected revision can never be
    // confused with (or overwritten by) the old public version.
    if (canInspectPrivate && row.draft_revision_row_id) {
      response.draft = {
        revisionId: row.draft_revision_row_id,
        revisionNo: row.draft_revision_no,
        status: row.draft_revision_status,
        submittedAt: row.draft_submitted_at,
        rejectionReasonCode: row.draft_reason_code,
        moderationNotes: row.draft_moderation_notes,
        ...row.draft_payload,
        media: serializeMedia(row.draft_media ?? [])
      };
    }

    return response;
  });

  app.post("/features", { preHandler: requireVerifiedContributor }, async (request, reply) => {
    const input = createFeatureSchema.parse(request.body);
    const userId = request.user!.id;
    const featureId = await transaction(async (client) => {
      const category = await client.query("SELECT 1 FROM categories WHERE key = $1 AND is_active = true", [input.categoryKey]);
      if (!category.rowCount) throw new AppError(400, "VALIDATION_FAILED", "Unknown category");
      await assertMediaUsable(client, userId, input.mediaIds);

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO map_features(category_key, owner_id, geom, location_accuracy_m, status)
         VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5, 'draft')
         RETURNING id`,
        [input.categoryKey, userId, input.longitude, input.latitude, input.locationAccuracyM]
      );
      const featureId = inserted.rows[0]!.id;
      const revision = await client.query<{ id: string }>(
        `INSERT INTO feature_revisions(feature_id, author_id, revision_no, payload, status)
         VALUES ($1, $2, 1, $3::jsonb, 'draft')
         RETURNING id`,
        [featureId, userId, JSON.stringify(payloadWithDate(input))]
      );
      const revisionId = revision.rows[0]!.id;
      await client.query("UPDATE map_features SET draft_revision_id = $2 WHERE id = $1", [featureId, revisionId]);
      await replaceRevisionMedia(client, revisionId, input.mediaIds);
      await recordAudit(client, {
        actorId: userId,
        action: "feature.draft_created",
        resourceType: "feature",
        resourceId: featureId,
        metadata: { categoryKey: input.categoryKey, revisionId }
      });
      return featureId;
    });

    return reply.code(201).send({ id: featureId, status: "draft" });
  });

  app.patch("/features/:id/draft", { preHandler: requireVerifiedContributor }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = createFeatureSchema.parse(request.body);
    const userId = request.user!.id;

    await transaction(async (client) => {
      const feature = await client.query<{
        status: string;
        owner_id: string;
        current_revision_id: string | null;
        draft_revision_id: string | null;
      }>(
        "SELECT status, owner_id, current_revision_id, draft_revision_id FROM map_features WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
        [params.id]
      );
      const row = feature.rows[0];
      if (!row) throw notFound("Feature not found");
      if (row.owner_id !== userId) throw forbidden();
      if (row.status === "hidden") throw conflict("Hidden content must be restored before it can be edited");
      if (row.status === "deleted") throw conflict("Deleted content cannot be edited");

      const revision = row.draft_revision_id
        ? await client.query<{ id: string; status: string }>(
            "SELECT id, status FROM feature_revisions WHERE id = $1 AND feature_id = $2 FOR UPDATE",
            [row.draft_revision_id, params.id]
          )
        : await client.query<{ id: string; status: string }>(
            "SELECT id, status FROM feature_revisions WHERE feature_id = $1 ORDER BY revision_no DESC LIMIT 1 FOR UPDATE",
            [params.id]
          );
      const revisionRow = revision.rows[0];
      if (!revisionRow) throw notFound("Draft revision not found");
      if (!EDITABLE_REVISION_STATUSES.includes(revisionRow.status as (typeof EDITABLE_REVISION_STATUSES)[number])) {
        throw conflict("The current revision is already waiting for moderation and cannot be edited");
      }
      const category = await client.query("SELECT 1 FROM categories WHERE key = $1 AND is_active = true", [input.categoryKey]);
      if (!category.rowCount) throw new AppError(400, "VALIDATION_FAILED", "Unknown or inactive category");
      await assertMediaUsable(client, userId, input.mediaIds);

      await client.query(
        `UPDATE feature_revisions
         SET payload = $2::jsonb, status = 'draft', rejection_reason_code = NULL,
             moderation_notes = NULL, reviewer_id = NULL, reviewed_at = NULL, updated_at = now()
         WHERE id = $1`,
        [revisionRow.id, JSON.stringify(payloadWithDate(input))]
      );
      await replaceRevisionMedia(client, revisionRow.id, input.mediaIds);

      if (row.current_revision_id) {
        // A public revision exists: it must stay untouched. The edit only
        // refreshes the in-flight draft; feature columns mirror the public
        // revision and are not overwritten.
        await client.query("UPDATE map_features SET updated_at = now() WHERE id = $1", [params.id]);
      } else {
        await client.query(
          `UPDATE map_features
           SET category_key = $2, geom = ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography,
               location_accuracy_m = $5, status = 'draft', draft_revision_id = $6, updated_at = now()
           WHERE id = $1`,
          [params.id, input.categoryKey, input.longitude, input.latitude, input.locationAccuracyM, revisionRow.id]
        );
      }
    });

    return { status: "draft" };
  });

  app.post("/features/:id/submit", { preHandler: requireVerifiedContributor }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    await submitRevision(undefined, params.id, request.user!.id);
    return { status: "pending" };
  });

  app.post("/features/:id/revisions", { preHandler: requireVerifiedContributor }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = createFeatureSchema.parse(request.body);
    const userId = request.user!.id;
    const revisionId = await transaction(async (client) => {
      const feature = await client.query<{
        owner_id: string;
        status: string;
        current_revision_id: string | null;
        draft_revision_id: string | null;
      }>(
        "SELECT owner_id, status, current_revision_id, draft_revision_id FROM map_features WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
        [params.id]
      );
      const row = feature.rows[0];
      if (!row) throw notFound("Feature not found");
      if (row.owner_id !== userId) throw forbidden();
      if (!row.current_revision_id) throw conflict("Use the draft endpoint before the first publication");
      if (row.status !== "published") throw conflict("Only published content can receive a new revision");
      if (row.draft_revision_id) {
        const draft = await client.query<{ status: string }>(
          "SELECT status FROM feature_revisions WHERE id = $1 FOR UPDATE",
          [row.draft_revision_id]
        );
        const draftStatus = draft.rows[0]?.status;
        if (draftStatus === "pending") throw conflict("A revision is already waiting for moderation");
        if (draftStatus && EDITABLE_REVISION_STATUSES.includes(draftStatus as (typeof EDITABLE_REVISION_STATUSES)[number])) {
          throw conflict("An editable draft revision already exists; update and resubmit it instead");
        }
      }
      const category = await client.query("SELECT 1 FROM categories WHERE key = $1 AND is_active = true", [input.categoryKey]);
      if (!category.rowCount) throw new AppError(400, "VALIDATION_FAILED", "Unknown or inactive category");
      await assertMediaUsable(client, userId, input.mediaIds);
      const next = await client.query<{ next: number }>(
        "SELECT COALESCE(MAX(revision_no), 0) + 1 AS next FROM feature_revisions WHERE feature_id = $1",
        [params.id]
      );
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO feature_revisions(feature_id, author_id, revision_no, payload, status)
         VALUES ($1, $2, $3, $4::jsonb, 'draft') RETURNING id`,
        [params.id, userId, next.rows[0]!.next, JSON.stringify(payloadWithDate(input))]
      );
      const newRevisionId = inserted.rows[0]!.id;
      await replaceRevisionMedia(client, newRevisionId, input.mediaIds);
      await client.query("UPDATE map_features SET draft_revision_id = $2, updated_at = now() WHERE id = $1", [params.id, newRevisionId]);
      return newRevisionId;
    });
    return reply.code(201).send({ id: revisionId, status: "draft" });
  });

  app.post("/features/:id/revisions/:revisionId/submit", { preHandler: requireVerifiedContributor }, async (request) => {
    const params = z.object({ id: z.string().uuid(), revisionId: z.string().uuid() }).parse(request.params);
    await submitRevision(params.revisionId, params.id, request.user!.id);
    return { status: "pending" };
  });

  app.get("/features/:id/revisions", { preHandler: requireAuth }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const feature = await query<{ owner_id: string }>("SELECT owner_id FROM map_features WHERE id = $1 AND deleted_at IS NULL", [params.id]);
    const row = feature.rows[0];
    if (!row) throw notFound("Feature not found");
    if (row.owner_id !== request.user!.id && !["moderator", "admin"].includes(request.user!.role)) throw forbidden();
    const result = await query(
      `SELECT fr.id, fr.revision_no, fr.status, fr.payload, fr.submitted_at, fr.reviewed_at,
              fr.rejection_reason_code, fr.moderation_notes, fr.created_at, fr.updated_at,
              (fr.id = mf.current_revision_id) AS is_current,
              (fr.id = mf.draft_revision_id) AS is_draft
       FROM feature_revisions fr
       JOIN map_features mf ON mf.id = fr.feature_id
       WHERE fr.feature_id = $1
       ORDER BY fr.revision_no DESC`,
      [params.id]
    );
    return result.rows;
  });

  app.delete("/features/:id", { preHandler: requireAuth }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const media = await transaction(async (client) => {
      const result = await client.query<{ owner_id: string }>(
        "SELECT owner_id FROM map_features WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
        [params.id]
      );
      const row = result.rows[0];
      if (!row) throw notFound("Feature not found");
      const canDelete = row.owner_id === request.user!.id || ["moderator", "admin"].includes(request.user!.role);
      if (!canDelete) throw forbidden();

      const mediaResult = await client.query<{
        id: string;
        quarantine_object_key: string;
        processed_object_key: string | null;
        thumbnail_object_key: string | null;
        public_object_key: string | null;
        public_thumbnail_object_key: string | null;
      }>(
        `SELECT DISTINCT ma.id, ma.quarantine_object_key, ma.processed_object_key,
                ma.thumbnail_object_key, ma.public_object_key, ma.public_thumbnail_object_key
         FROM revision_media rm
         JOIN feature_revisions fr ON fr.id = rm.revision_id
         JOIN media_assets ma ON ma.id = rm.media_id
         WHERE fr.feature_id = $1 AND ma.deleted_at IS NULL`,
        [params.id]
      );

      await client.query(
        "UPDATE map_features SET status = 'deleted', deleted_at = now(), updated_at = now() WHERE id = $1",
        [params.id]
      );
      if (mediaResult.rowCount) {
        await client.query(
          `UPDATE media_assets SET privacy_status = 'deleted', deleted_at = now(), updated_at = now()
           WHERE id = ANY($1::uuid[])`,
          [mediaResult.rows.map((item) => item.id)]
        );
      }
      await recordAudit(client, {
        actorId: request.user!.id,
        action: "feature.deleted",
        resourceType: "feature",
        resourceId: params.id,
        metadata: { mediaCount: mediaResult.rowCount }
      });
      return mediaResult.rows;
    });

    const removals = media.flatMap((item) => [
      deleteObject(config.S3_QUARANTINE_BUCKET, item.quarantine_object_key),
      item.processed_object_key ? deleteObject(config.S3_QUARANTINE_BUCKET, item.processed_object_key) : Promise.resolve(),
      item.thumbnail_object_key ? deleteObject(config.S3_QUARANTINE_BUCKET, item.thumbnail_object_key) : Promise.resolve(),
      item.public_object_key ? deleteObject(config.S3_PUBLIC_BUCKET, item.public_object_key) : Promise.resolve(),
      item.public_thumbnail_object_key ? deleteObject(config.S3_PUBLIC_BUCKET, item.public_thumbnail_object_key) : Promise.resolve()
    ]);
    await Promise.allSettled(removals);
    return { status: "deleted" };
  });

  app.get("/me/features", { preHandler: requireAuth }, async (request) => {
    const result = await query(
      `SELECT mf.id, mf.category_key, mf.status, mf.created_at, mf.updated_at,
              mf.current_revision_id,
              fr.id AS revision_id, fr.revision_no, fr.status AS revision_status,
              COALESCE(fr.payload, cur.payload) AS payload,
              fr.rejection_reason_code, fr.moderation_notes
       FROM map_features mf
       LEFT JOIN feature_revisions fr ON fr.id = mf.draft_revision_id
       LEFT JOIN feature_revisions cur ON cur.id = mf.current_revision_id
       WHERE mf.owner_id = $1 AND mf.deleted_at IS NULL
       ORDER BY mf.updated_at DESC`,
      [request.user!.id]
    );
    return result.rows;
  });

  app.get("/features/:id/confirmations", async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await query(
      `SELECT result, count(*)::int AS count, max(created_at) AS latest_at
       FROM feature_confirmations
       WHERE feature_id = $1 AND created_at > now() - interval '180 days'
       GROUP BY result`,
      [params.id]
    );
    return result.rows;
  });

  app.post("/features/:id/confirmations", { preHandler: requireAuth }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = z.object({
      result: z.enum(["still_accurate", "changed", "closed"]),
      note: z.string().trim().max(500).optional()
    }).parse(request.body);

    await transaction(async (client) => {
      const feature = await client.query<{ status: string }>(
        "SELECT status FROM map_features WHERE id = $1 AND deleted_at IS NULL",
        [params.id]
      );
      if (feature.rows[0]?.status !== "published") throw notFound("Published feature not found");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO feature_confirmations(feature_id, user_id, result, note)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (feature_id, user_id) DO UPDATE
           SET result = EXCLUDED.result, note = EXCLUDED.note, created_at = now()
           WHERE feature_confirmations.created_at < now() - interval '90 days'
         RETURNING id`,
        [params.id, request.user!.id, input.result, input.note ?? null]
      );
      if (!inserted.rowCount) throw conflict("This feature was already confirmed within the last 90 days");

      if (input.result !== "still_accurate") {
        const risky = await client.query<{ count: number }>(
          `SELECT count(DISTINCT user_id)::int AS count
           FROM feature_confirmations
           WHERE feature_id = $1 AND result IN ('changed', 'closed')
             AND created_at > now() - interval '7 days'`,
          [params.id]
        );
        if (risky.rows[0]!.count >= 3) {
          await client.query(
            "UPDATE map_features SET needs_review_at = now(), updated_at = now() WHERE id = $1",
            [params.id]
          );
        }
      }
    });
    return { status: "recorded" };
  });
}

async function submitRevision(revisionId: string | undefined, featureId: string, userId: string) {
  await transaction(async (client) => {
    const feature = await client.query<{
      owner_id: string;
      status: string;
      current_revision_id: string | null;
      draft_revision_id: string | null;
    }>(
      "SELECT owner_id, status, current_revision_id, draft_revision_id FROM map_features WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
      [featureId]
    );
    const featureRow = feature.rows[0];
    if (!featureRow) throw notFound("Feature not found");
    if (featureRow.owner_id !== userId) throw forbidden();

    const targetRevisionId = revisionId ?? featureRow.draft_revision_id;
    if (!targetRevisionId) throw notFound("Draft revision not found");
    if (featureRow.draft_revision_id && targetRevisionId !== featureRow.draft_revision_id) {
      throw conflict("Only the current in-flight revision can be submitted");
    }

    const revision = await client.query<{ id: string; status: string; payload: unknown }>(
      "SELECT id, status, payload FROM feature_revisions WHERE id = $1 AND feature_id = $2 FOR UPDATE",
      [targetRevisionId, featureId]
    );
    const revisionRow = revision.rows[0];
    if (!revisionRow) throw notFound("Revision not found");
    if (!EDITABLE_REVISION_STATUSES.includes(revisionRow.status as (typeof EDITABLE_REVISION_STATUSES)[number])) {
      throw conflict("Revision is not eligible for submission");
    }
    if (featureRow.status === "hidden") throw conflict("Hidden content must be restored before resubmission");

    const payload = revisionRow.payload as { mediaIds?: string[] };
    await assertMediaUsable(client, userId, payload.mediaIds ?? []);
    await client.query(
      `UPDATE feature_revisions
       SET status = 'pending', submitted_at = now(), reviewed_at = NULL,
           reviewer_id = NULL, rejection_reason_code = NULL, updated_at = now()
       WHERE id = $1`,
      [revisionRow.id]
    );
    if (!featureRow.current_revision_id) {
      await client.query("UPDATE map_features SET status = 'pending', updated_at = now() WHERE id = $1", [featureId]);
    }
  });
}
