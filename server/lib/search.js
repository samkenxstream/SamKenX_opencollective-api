/**
 * Functions related to search
 */

import config from 'config';
import slugify from 'limax';
import { get, sortBy } from 'lodash';

import { RateLimitExceeded } from '../graphql/errors';
import models, { Op, sequelize } from '../models';

import RateLimit, { ONE_HOUR_IN_SECONDS } from './rate-limit';

// Returned when there's no result for a search
const EMPTY_SEARCH_RESULT = [[], 0];

/**
 * Search users by email address. `user` must be set because this endpoint is rate
 * limited to prevent abuse.
 *
 * @param {String} email - a valid email address
 * @param {Object} user - the user triggering the search
 */
export const searchCollectivesByEmail = async (email, user, offset = 0, limit = 10) => {
  if (!email || !user) {
    return EMPTY_SEARCH_RESULT;
  }

  // Put some rate limiting to users can't use this endpoint to bruteforce emails
  const rateLimit = new RateLimit(
    `user_email_search_${user.id}`,
    config.limits.searchEmailPerHour,
    ONE_HOUR_IN_SECONDS,
  );

  if (!(await rateLimit.registerCall())) {
    throw new RateLimitExceeded();
  }

  // Emails are uniques, thus there should never be more than one result - this is
  // why it's safe to use `collectives.length` in the return.
  const collectives = await sequelize.query(
    `
    SELECT  c.*, COUNT(*) OVER() AS __total__
    FROM "Collectives" c
    INNER JOIN "Users" u ON u."CollectiveId" = c.id
    WHERE c."isIncognito" = FALSE AND c.type = 'USER' AND u.email = :email
    OFFSET :offset
    LIMIT :limit
    `,
    {
      model: models.Collective,
      mapToModel: true,
      replacements: { offset, limit, email },
    },
  );

  return [collectives, get(collectives[0], 'dataValues.__total__', 0)];
};

/**
 * Turn a search string into a TS vector using 'OR' operator.
 *
 * Ex: "open potatoes" => "open|potatoes"
 */
const searchTermToTsVector = term => {
  return term.replace(/\s+/g, '|');
};

/**
 * TSVector to search for collectives names/description/slug
 * Updating the value here requires generating a new migration to update the index.
 * See `migrations/20201119100223-update-collectives-search-index.js`
 */
export const TS_VECTOR = `
  to_tsvector('simple', name)
  || to_tsvector('simple', slug)
  || to_tsvector('simple', COALESCE(description, ''))
  || COALESCE(array_to_tsvector(tags), '')
  || to_tsvector('simple', COALESCE("longDescription", ''))
`;

/**
 * Search collectives directly in the DB, using a full-text query.
 */
export const searchCollectivesInDB = async (
  term,
  offset = 0,
  limit = 100,
  { types, hostCollectiveIds, isHost, onlyActive } = {},
) => {
  // Build dynamic conditions based on arguments
  let dynamicConditions = '';

  if (hostCollectiveIds && hostCollectiveIds.length > 0) {
    dynamicConditions += 'AND "HostCollectiveId" IN (:hostCollectiveIds) ';
  }

  if (isHost !== undefined) {
    dynamicConditions += 'AND "isHostAccount" = :isHost ';
  }

  if (types?.length) {
    dynamicConditions += `AND type IN (:types) `;
  }

  if (onlyActive) {
    dynamicConditions += 'AND "isActive" = TRUE ';
  }

  // Cleanup term
  if (term && term.length > 0) {
    term = term.replace(/(_|%|\\)/g, ' ').trim();
    dynamicConditions += `AND (${TS_VECTOR} @@ plainto_tsquery('simple', :vectorizedTerm) OR name ILIKE '%' || :term || '%' OR slug ILIKE '%' || :term || '%') `;
  } else {
    term = '';
  }

  // Build the query
  const result = await sequelize.query(
    `
    SELECT 
      c.*, 
      COUNT(*) OVER() AS __total__,
      (
        CASE WHEN (slug = :slugifiedTerm OR name ILIKE :term) THEN
          1
        ELSE
          ts_rank(${TS_VECTOR}, plainto_tsquery('simple', :vectorizedTerm))
        END
      ) AS __rank__
    FROM "Collectives" c
    WHERE "deletedAt" IS NULL
    AND "deactivatedAt" IS NULL
    AND "isIncognito" = FALSE ${dynamicConditions}
    ORDER BY __rank__ DESC
    OFFSET :offset
    LIMIT :limit
    `,
    {
      model: models.Collective,
      mapToModel: true,
      replacements: {
        types,
        term: term,
        slugifiedTerm: slugify(term),
        vectorizedTerm: searchTermToTsVector(term),
        offset,
        limit,
        hostCollectiveIds,
        isHost,
      },
    },
  );

  return [result, get(result[0], 'dataValues.__total__', 0)];
};
