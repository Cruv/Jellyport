/**
 * Project older jobs inside SQLite during the one-time summary backfill. The
 * outcome classifier gets its evidence without loading item diagnostics into JS.
 */
export const legacyJobSummaryInput = `
  SELECT json_object(
    'id', jobs.id,
    'kind', COALESCE(json_extract(payload, '$.kind'), 'operation'),
    'status', COALESCE(json_extract(payload, '$.status'), 'unknown'),
    'created_at', json_extract(payload, '$.created_at'),
    'updated_at', json_extract(payload, '$.updated_at'),
    'finished_at', json_extract(payload, '$.finished_at'),
    'migration_scope', json_extract(payload, '$.migration_scope'),
    'cancel_requested', json_extract(payload, '$.cancel_requested'),
    'error', CASE WHEN length(json_extract(payload, '$.error')) > 0 THEN 'error' END,
    'progress', json_extract(payload, '$.progress'),
    'membership_discord_user_id', json_extract(payload, '$.membership_discord_user_id'),
    'source_snapshot_ids', json_extract(payload, '$.source_snapshot_ids'),
    'destination_catalog_id', json_extract(payload, '$.destination_catalog_id'),
    'results', json((SELECT json_group_array(json_object(
      'username', json_extract(value, '$.username'),
      'status', json_extract(value, '$.status'),
      'matched', json_extract(value, '$.matched'),
      'unmatched', json_extract(value, '$.unmatched'),
      'ambiguous', json_extract(value, '$.ambiguous'),
      'applied', json_extract(value, '$.applied'),
      'error', CASE WHEN length(json_extract(value, '$.error')) > 0 THEN 'error' END,
      'delivery_error', CASE WHEN length(json_extract(value, '$.delivery_error')) > 0 THEN 'error' END,
      'discord_delivery', CASE json_type(value, '$.discord_delivery')
        WHEN 'object' THEN COALESCE(json_extract(value, '$.discord_delivery.status'), 'unknown')
        WHEN 'null' THEN 'unknown'
        ELSE json_extract(value, '$.discord_delivery') END,
      'warnings', CASE WHEN json_array_length(value, '$.warnings') > 0 THEN json_array('warning') END,
      'migration_outcome', json_extract(value, '$.migration_outcome'),
      'data', json_object(
        'failed_items', json_extract(value, '$.data.failed_items'),
        'items_updated', json_extract(value, '$.data.items_updated'),
        'failed_updates', CASE WHEN json_array_length(value, '$.data.failed_updates') > 0 THEN json_array(1) END,
        'write_metrics', json_extract(value, '$.data.write_metrics'),
        'verification', json_extract(value, '$.data.verification')
      )
    )) FROM json_each(jobs.payload, '$.results') WHERE json_each.type='object'))
  ) AS payload
  FROM jobs
  WHERE NOT EXISTS(SELECT 1 FROM job_summaries WHERE job_summaries.id=jobs.id)
`;
