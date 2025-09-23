const axios = require('axios');
const winston = require('winston');

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
        bii_url: `https://app.buildinginfo.com/project/${planningId}`,
        planning_updated: 'N/A',
        planning_stage: 'N/A',
        planning_sector: 'N/A',
        planning_authority: 'N/A',
        planning_status: 'N/A'
      };

      if (!data || typeof data !== 'object') {
        logger.warn(`Invalid response from Building Info API for ${planningId}`);
        this.cache.set(cacheKey, { data: fallbackData, timestamp: Date.now() });
        return fallbackData;
      }

      if (data.success === false) {
        logger.warn(`Building Info API returned success=false for ${planningId}`);
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
      const result = {
        planning_title: row.planning_title || 'Untitled project',
        planning_id: planningId,
        bii_url: `https://app.buildinginfo.com/${row.planning_path_url || ''}`,
        planning_updated: (row.planning_public_updated || row.api_date || 'N/A').slice(0, 10),
        planning_stage: row.planning_stage || 'N/A',
        planning_sector: row.planning_category || 'N/A',
        planning_authority: row.planning_authority || 'N/A',
        planning_status: row.planning_status || 'N/A',
        planning_description: row.planning_description || '',
        planning_location: row.planning_location || '',
        planning_applicant: row.planning_applicant || 'N/A'
      };

      // Cache the result
      this.cache.set(cacheKey, { data: result, timestamp: Date.now() });

      logger.info(`Retrieved metadata for project ${planningId}: ${result.planning_title}`);
      return result;

    } catch (error) {
      logger.error(`Error fetching metadata for project ${planningId}:`, error);
      const fallbackData = {
        planning_title: 'Title unavailable',
        planning_id: planningId,
        bii_url: `https://app.buildinginfo.com/project/${planningId}`,
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
            bii_url: `https://app.buildinginfo.com/project/${planningId}`,
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
        bii_url: `https://app.buildinginfo.com/${row.planning_path_url || ''}`
      }));

    } catch (error) {
      logger.error('Error searching projects:', error);
      return [];
    }
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
    logger.info('Building Info API cache cleared');
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