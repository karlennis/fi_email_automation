const axios = require('axios');
const winston = require('winston');
require('dotenv').config(); // Load environment variables

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console()
  ]
});

class BuildingInfoService {
  constructor() {
    this.baseUrl = process.env.BUILDING_INFO_API_BASE_URL ||
      'https://api12.buildinginfo.com/api/v2/bi/projects/t-projects';
    this.apiKey = process.env.BUILDING_INFO_API_KEY;
    this.ukey = process.env.BUILDING_INFO_API_UKEY;
    this.cache = new Map();
    this.cacheTimeout = 24 * 60 * 60 * 1000; // 24 hours
  }

  /**
   * Build API URL for a specific planning ID
   */
  buildDetailUrl(planningId) {
    return `${this.baseUrl}?api_key=${this.apiKey}&ukey=${this.ukey}&planning_id=${planningId}`;
  }

  /**
   * Make API call with error handling and rate limiting
   */
  async makeApiCall(url) {
    try {
      const response = await axios.get(url, { timeout: 15000 });

      // Rate limiting - wait between calls
      await new Promise(resolve => setTimeout(resolve, 100));

      return response.data;
    } catch (error) {
      if (error.response) {
        logger.warn(`Building Info API error for ${url}: ${error.response.status} - ${error.response.statusText}`);
      } else {
        logger.warn(`Building Info API network error: ${error.message}`);
      }
      return null;
    }
  }

  /**
   * Get project metadata from Building Info API with caching
   */
  async getProjectMetadata(planningId) {
    // Check cache first
    const cacheKey = `project_${planningId}`;
    const cached = this.cache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.data;
    }

    try {
      const url = this.buildDetailUrl(planningId);
      const data = await this.makeApiCall(url);

      // Default fallback data
      const fallbackData = {
        planning_title: 'Title unavailable',
        planning_id: planningId,
        bii_url: null, // No valid URL available
        planning_updated: 'N/A',
        planning_stage: 'N/A',
        planning_sector: 'N/A',
        planning_authority: 'N/A',
        planning_status: 'N/A'
      };

      if (!data || typeof data !== 'object') {
        logger.warn(`Invalid response from Building Info API for ${planningId}:`, data);
        this.cache.set(cacheKey, { data: fallbackData, timestamp: Date.now() });
        return fallbackData;
      }

      if (data.success === false || data.status !== 'OK') {
        logger.warn(`Building Info API returned error for ${planningId}:`, { success: data.success, status: data.status, message: data.message });
        this.cache.set(cacheKey, { data: fallbackData, timestamp: Date.now() });
        return fallbackData;
      }

      const rows = data.data?.rows;
      if (!rows || !Array.isArray(rows) || rows.length === 0) {
        logger.warn(`No data rows returned from Building Info API for ${planningId}`);
        this.cache.set(cacheKey, { data: fallbackData, timestamp: Date.now() });
        return fallbackData;
      }

      const row = rows[0];

      // Log the actual row data to debug field names
      logger.info(`Raw API row data for ${planningId}:`, {
        planning_stage: row.planning_stage,
        planning_category: row.planning_category,
        planning_authority: row.planning_authority,
        planning_path_url: row.planning_path_url,
        has_valid_path_url: !!(row.planning_path_url && row.planning_path_url.trim()),
        available_fields: Object.keys(row).filter(key => key.includes('planning')).slice(0, 10)
      });

      const result = {
        planning_title: row.planning_title || 'Untitled project',
        planning_id: planningId,
        bii_url: (row.planning_path_url && row.planning_path_url.trim()) ? `https://app.buildinginfo.com/${row.planning_path_url}` : null,
        planning_updated: (row.planning_public_updated || row.api_date || 'N/A').slice(0, 10),
        planning_stage: row.planning_stage || 'N/A',
        planning_sector: row.planning_category || 'N/A',
        planning_authority: row.planning_authority || 'N/A',
        planning_status: row.planning_status || 'N/A',
        planning_description: row.planning_description || '',
        planning_location: row.planning_location || '',
        planning_applicant: row.planning_applicant || 'N/A'
      };

      // Enhanced debugging
      logger.info(`✅ Metadata constructed for ${planningId}:`, {
        planning_title: result.planning_title,
        bii_url: result.bii_url,
        planning_stage: result.planning_stage,
        planning_sector: result.planning_sector,
        rawTitle: row.planning_title,
        rawPathUrl: row.planning_path_url,
        hasValidUrl: !!(result.bii_url)
      });

      // Cache the result
      this.cache.set(cacheKey, { data: result, timestamp: Date.now() });

      logger.info(`Retrieved metadata for project ${planningId}: ${result.planning_title}`, {
        planning_title: result.planning_title,
        bii_url: result.bii_url,
        planning_stage: result.planning_stage
      });
      return result;

    } catch (error) {
      logger.error(`Error fetching metadata for project ${planningId}:`, error);
      const fallbackData = {
        planning_title: 'Title unavailable',
        planning_id: planningId,
        bii_url: null, // No valid URL available
        planning_updated: 'N/A',
        planning_stage: 'N/A',
        planning_sector: 'N/A',
        planning_authority: 'N/A',
        planning_status: 'N/A'
      };

      this.cache.set(cacheKey, { data: fallbackData, timestamp: Date.now() });
      return fallbackData;
    }
  }

  /**
   * Get metadata for multiple projects in batch
   */
  async getBatchProjectMetadata(planningIds) {
    const results = {};
    const batchSize = 5; // Process in small batches to avoid rate limiting

    for (let i = 0; i < planningIds.length; i += batchSize) {
      const batch = planningIds.slice(i, i + batchSize);
      const batchPromises = batch.map(id =>
        this.getProjectMetadata(id).then(data => ({ id, data }))
      );

      const batchResults = await Promise.allSettled(batchPromises);

      batchResults.forEach((result, index) => {
        const planningId = batch[index];
        if (result.status === 'fulfilled') {
          results[planningId] = result.value.data;
        } else {
          logger.error(`Failed to get metadata for ${planningId}:`, result.reason);
          results[planningId] = {
            planning_title: 'Error loading data',
            planning_id: planningId,
            bii_url: null, // No valid URL available
            planning_updated: 'N/A',
            planning_stage: 'N/A',
            planning_sector: 'N/A',
            planning_authority: 'N/A',
            planning_status: 'Error'
          };
        }
      });

      // Wait between batches
      if (i + batchSize < planningIds.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    return results;
  }

  /**
   * Search projects by criteria
   */
  async searchProjects(criteria = {}) {
    try {
      let url = `${this.baseUrl}?api_key=${this.apiKey}&ukey=${this.ukey}`;

      // Add search parameters
      if (criteria.planning_authority) {
        url += `&planning_authority=${encodeURIComponent(criteria.planning_authority)}`;
      }
      if (criteria.planning_stage) {
        url += `&planning_stage=${encodeURIComponent(criteria.planning_stage)}`;
      }
      if (criteria.planning_category) {
        url += `&planning_category=${encodeURIComponent(criteria.planning_category)}`;
      }
      if (criteria.updated_since) {
        url += `&planning_public_updated=${criteria.updated_since}`;
      }

      const data = await this.makeApiCall(url);

      if (!data || !data.data || !data.data.rows) {
        return [];
      }

      return data.data.rows.map(row => ({
        planning_id: row.planning_id,
        planning_title: row.planning_title,
        planning_authority: row.planning_authority,
        planning_stage: row.planning_stage,
        planning_updated: (row.planning_public_updated || row.api_date || '').slice(0, 10),
        bii_url: (row.planning_path_url && row.planning_path_url.trim()) ? `https://app.buildinginfo.com/${row.planning_path_url}` : null
      }));

    } catch (error) {
      logger.error('Error searching projects:', error);
      return [];
    }
  }

  /**
   * Build API URL to retrieve projects with filters (similar to get_one_thousand)
   */
  buildFilteredUrl(limitStart, paramsObject) {
    let apiUrl = `${this.baseUrl}?api_key=${this.apiKey}&ukey=${this.ukey}`;

    // Add filtering parameters (only if they're not null/0)
    if (paramsObject.category && paramsObject.category !== 0) {
      apiUrl += `&category=${paramsObject.category}`;
    }
    if (paramsObject.subcategory && paramsObject.subcategory !== 0) {
      apiUrl += `&subcategory=${paramsObject.subcategory}`;
    }
    if (paramsObject.county && paramsObject.county !== 0) {
      apiUrl += `&county=${paramsObject.county}`;
    }
    if (paramsObject.type && paramsObject.type !== 0) {
      apiUrl += `&type=${paramsObject.type}`;
    }
    if (paramsObject.stage && paramsObject.stage !== 0) {
      apiUrl += `&stage=${paramsObject.stage}`;
    }
    if (paramsObject.latitude && paramsObject.longitude && paramsObject.radius) {
      apiUrl += `&nearby=${paramsObject.latitude},${paramsObject.longitude}&radius=${paramsObject.radius}`;
    }

    // Add date filtering with _apion parameter (api_date field - all updates)
    // Use min_apion with 'z' suffix for precise control (e.g., -1z = yesterday at 00:00:00)
    if (paramsObject.min_apion !== undefined && paramsObject.min_apion !== null) {
      apiUrl += `&min_apion=${paramsObject.min_apion}`;
      // Don't set _apion when using min_apion
    } else if (paramsObject._apion !== undefined && paramsObject._apion !== null) {
      apiUrl += `&_apion=${paramsObject._apion}`;

      // If using date range (_apion = 8), add max date
      if ((paramsObject._apion === 8 || paramsObject._apion === '8') && paramsObject.max_apion) {
        apiUrl += `&max_apion=${paramsObject.max_apion}`;
      }
    } else {
      // Default: Use min_apion=-1z to get everything from yesterday at 00:00:00
      apiUrl += `&min_apion=-1z`;
    }

    apiUrl += `&more=limit ${limitStart},1000`;

    logger.info(`📡 Building Info API URL: ${apiUrl}`);
    return apiUrl;
  }

  /**
   * Get projects by parameters (similar to get_projects_by_params in query_service_pipeline)
   */
  async getProjectsByParams(paramsObject = {}) {
    let limitStart = 0;
    const allProjectIds = [];
    const allRows = [];

    while (true) {
      const apiUrl = this.buildFilteredUrl(limitStart, paramsObject);
      logger.info(`🔄 Calling Building Info API (batch ${limitStart/1000 + 1}): ${apiUrl}`);

      try {
        const response = await axios.get(apiUrl, { timeout: 30000 });
        const data = response.data;

        if (data.status !== "OK" || !data.data) {
          logger.warn('API response indicates no more data or error');
          break;
        }

        const rows = data.data.rows || [];
        if (!rows.length) {
          logger.info('No more rows returned, pagination complete');
          break;
        }

        const projectIds = rows
          .map(row => row.planning_id)
          .filter(id => id); // Filter out null/undefined IDs

        logger.info(`Fetched ${projectIds.length} project IDs from this batch`);
        allProjectIds.push(...projectIds);
        allRows.push(...rows);

        // If we got less than 1000 results, we've reached the end
        if (rows.length < 1000) {
          logger.info('Received less than 1000 rows, pagination complete');
          break;
        }

        limitStart += 1000;

        // Rate limiting between batches
        await new Promise(resolve => setTimeout(resolve, 200));

      } catch (error) {
        logger.error(`API call failed for batch starting at ${limitStart}:`, error.message);
        break;
      }
    }

    logger.info(`Total project IDs fetched: ${allProjectIds.length}`);

    return {
      projectIds: allProjectIds,
      projectData: allRows,
      totalCount: allProjectIds.length
    };
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return {
      cacheSize: this.cache.size,
      cacheTimeout: this.cacheTimeout,
      cachedProjects: Array.from(this.cache.keys())
    };
  }
}

module.exports = new BuildingInfoService();