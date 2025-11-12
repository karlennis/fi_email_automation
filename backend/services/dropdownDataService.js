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

class DropdownDataService {
  constructor() {
    // Categories for project filtering
    this.categories = [
      { id: 1, name: 'Residential' },
      { id: 2, name: 'Commercial & Retail' },
      { id: 3, name: 'Industrial' },
      { id: 4, name: 'Education' },
      { id: 5, name: 'Medical' },
      { id: 6, name: 'Civil' },
      { id: 7, name: 'Social' },
      { id: 8, name: 'Agriculture' },
      { id: 9, name: 'Supply & Services' },
      { id: 10, name: 'Self Build' }
    ];

    // Subcategories with their parent category IDs
    this.subCategories = [
      { id: 1, name: 'Houses', categoryID: 1 },
      { id: 2, name: 'Apartments', categoryID: 1 },
      { id: 3, name: 'Mixed Development', categoryID: 1 },
      { id: 4, name: 'Retail', categoryID: 2 },
      { id: 5, name: 'Office', categoryID: 2 },
      { id: 6, name: 'Service Station', categoryID: 2 },
      { id: 7, name: 'Car Showroom', categoryID: 2 },
      { id: 8, name: 'Hotel & Guesthouse', categoryID: 2 },
      { id: 9, name: 'Bar & Restaurant', categoryID: 2 },
      { id: 11, name: 'Factory', categoryID: 3 },
      { id: 12, name: 'Warehouse', categoryID: 3 },
      { id: 10, name: 'Light Industrial', categoryID: 3 },
      { id: 14, name: 'School', categoryID: 4 },
      { id: 15, name: 'University', categoryID: 4 },
      { id: 16, name: 'Pre School', categoryID: 4 },
      { id: 17, name: 'Hospital', categoryID: 5 },
      { id: 18, name: 'Care Home', categoryID: 5 },
      { id: 19, name: 'Medical Centre', categoryID: 5 },
      { id: 21, name: 'Road & Path', categoryID: 6 },
      { id: 22, name: 'Water & Sewerage', categoryID: 6 },
      { id: 23, name: 'Transport', categoryID: 6 },
      { id: 24, name: 'Carpark', categoryID: 6 },
      { id: 25, name: 'Power Generation', categoryID: 6 },
      { id: 37, name: 'Quarry', categoryID: 6 },
      { id: 27, name: 'Sport & Leisure', categoryID: 7 },
      { id: 28, name: 'Church & Community', categoryID: 7 },
      { id: 29, name: 'Public Building', categoryID: 7 },
      { id: 31, name: 'Agricultural Building', categoryID: 8 },
      { id: 32, name: 'Professional Services', categoryID: 9 },
      { id: 33, name: 'Construction Supplies', categoryID: 9 },
      { id: 34, name: 'House', categoryID: 10 },
      { id: 35, name: 'Extension', categoryID: 10 },
      { id: 36, name: 'Alteration', categoryID: 10 }
    ];

    // Irish counties (fixing duplicate Longford)
    this.counties = [
      { id: 1, name: 'Dublin' },
      { id: 2, name: 'Wicklow' },
      { id: 3, name: 'Wexford' },
      { id: 4, name: 'Carlow' },
      { id: 5, name: 'Kildare' },
      { id: 6, name: 'Meath' },
      { id: 7, name: 'Louth' },
      { id: 8, name: 'Monaghan' },
      { id: 9, name: 'Cavan' },
      { id: 10, name: 'Longford' },
      { id: 12, name: 'Westmeath' },
      { id: 13, name: 'Offaly' },
      { id: 14, name: 'Laois' },
      { id: 15, name: 'Kilkenny' },
      { id: 16, name: 'Waterford' },
      { id: 17, name: 'Cork' },
      { id: 18, name: 'Kerry' },
      { id: 19, name: 'Limerick' },
      { id: 20, name: 'Tipperary' },
      { id: 21, name: 'Clare' },
      { id: 22, name: 'Galway' },
      { id: 23, name: 'Mayo' },
      { id: 24, name: 'Roscommon' },
      { id: 25, name: 'Sligo' },
      { id: 26, name: 'Leitrim' },
      { id: 27, name: 'Donegal' },
      { id: 28, name: 'Antrim & Newtownabbey' },
      { id: 29, name: 'Armagh Banbridge & Craigavon' }
    ];

    // Planning stages
    this.stages = [
      { id: 1, name: 'Plans Applied' },
      { id: 2, name: 'Plans Withdrawn/Invalid' },
      { id: 3, name: 'Plans Refused' },
      { id: 4, name: 'Plans Granted' },
      { id: 5, name: 'Tender' },
      { id: 7, name: 'Commencement' },
      { id: 11, name: 'Pre Planning' }
    ];

    // Project types
    this.types = [
      { id: 1, name: 'New Build' },
      { id: 2, name: 'Extension' },
      { id: 3, name: 'Alterations' }
    ];
  }

  /**
   * Get all categories
   */
  getCategories() {
    return this.categories;
  }

  /**
   * Get subcategories for a specific category
   */
  getSubCategories(categoryId = null) {
    if (categoryId) {
      return this.subCategories.filter(sub => sub.categoryID === categoryId);
    }
    return this.subCategories;
  }

  /**
   * Get all counties
   */
  getCounties() {
    return this.counties;
  }

  /**
   * Get all planning stages
   */
  getStages() {
    return this.stages;
  }

  /**
   * Get all project types
   */
  getTypes() {
    return this.types;
  }

  /**
   * Get all dropdown data in the format expected by frontend
   */
  getAllDropdownData() {
    // Restructure categories to include nested subcategories
    const categoriesWithSubcategories = this.categories.map(category => ({
      id: category.id,
      name: category.name,
      subcategories: this.subCategories.filter(sub => sub.categoryID === category.id)
        .map(sub => ({ id: sub.id, name: sub.name }))
    }));

    return {
      categories: categoriesWithSubcategories,
      counties: this.counties,
      stages: this.stages,
      types: this.types
    };
  }

  /**
   * Find category by ID
   */
  getCategoryById(id) {
    return this.categories.find(cat => cat.id === id);
  }

  /**
   * Find subcategory by ID
   */
  getSubCategoryById(id) {
    return this.subCategories.find(sub => sub.id === id);
  }

  /**
   * Find county by ID
   */
  getCountyById(id) {
    return this.counties.find(county => county.id === id);
  }

  /**
   * Find stage by ID
   */
  getStageById(id) {
    return this.stages.find(stage => stage.id === id);
  }

  /**
   * Find type by ID
   */
  getTypeById(id) {
    return this.types.find(type => type.id === id);
  }

  /**
   * Validate filtering parameters
   */
  validateParams(params) {
    const errors = [];
    const warnings = [];

    // Helper function to validate comma-separated IDs
    const validateIds = (paramValue, validatorFunc, paramName) => {
      if (!paramValue) return true;

      // Convert to string and split by comma
      const ids = String(paramValue).split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));

      // Validate each ID
      for (const id of ids) {
        if (!validatorFunc.call(this, id)) {
          errors.push(`Invalid ${paramName} ID: ${id}`);
        }
      }

      return ids.length > 0;
    };

    // Validate all filter parameters (supports both single IDs and comma-separated lists)
    if (params.category) {
      validateIds(params.category, this.getCategoryById, 'category');
    }

    if (params.subcategory) {
      validateIds(params.subcategory, this.getSubCategoryById, 'subcategory');
    }

    if (params.county) {
      validateIds(params.county, this.getCountyById, 'county');
    }

    if (params.stage) {
      validateIds(params.stage, this.getStageById, 'stage');
    }

    if (params.type) {
      validateIds(params.type, this.getTypeById, 'type');
    }

    // Check if subcategory belongs to selected category (for single values only)
    if (params.category && params.subcategory) {
      const categoryIds = String(params.category).split(',').map(id => parseInt(id.trim()));
      const subcategoryIds = String(params.subcategory).split(',').map(id => parseInt(id.trim()));

      // Only validate relationship if both are single values
      if (categoryIds.length === 1 && subcategoryIds.length === 1) {
        const subcategory = this.getSubCategoryById(subcategoryIds[0]);
        if (subcategory && subcategory.categoryID !== categoryIds[0]) {
          errors.push(`Subcategory ${subcategoryIds[0]} does not belong to category ${categoryIds[0]}`);
        }
      }
    }

    // Warning if no filters are applied (but _apion or min_apion alone is fine - filters by update date)
    if (!params.category && !params.county && !params.stage && !params.type && !params._apion && !params.min_apion) {
      warnings.push('No filters applied - this may return a large number of results');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Build a human-readable summary of applied filters
   */
  buildFilterSummary(params) {
    const parts = [];

    // Helper function to get names for comma-separated IDs
    const getNames = (paramValue, getterFunc) => {
      if (!paramValue) return [];
      const ids = String(paramValue).split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
      return ids.map(id => {
        const item = getterFunc.call(this, id);
        return item ? item.name : `Unknown (${id})`;
      });
    };

    if (params.category) {
      const names = getNames(params.category, this.getCategoryById);
      if (names.length > 0) parts.push(`Category: ${names.join(', ')}`);
    }

    if (params.subcategory) {
      const names = getNames(params.subcategory, this.getSubCategoryById);
      if (names.length > 0) parts.push(`Subcategory: ${names.join(', ')}`);
    }

    if (params.county) {
      const names = getNames(params.county, this.getCountyById);
      if (names.length > 0) parts.push(`County: ${names.join(', ')}`);
    }

    if (params.stage) {
      const names = getNames(params.stage, this.getStageById);
      if (names.length > 0) parts.push(`Stage: ${names.join(', ')}`);
    }

    if (params.type) {
      const names = getNames(params.type, this.getTypeById);
      if (names.length > 0) parts.push(`Type: ${names.join(', ')}`);
    }

    if (params._apion) {
      parts.push(`All updates within: ${params._apion} days`);
    }

    if (params.min_apion) {
      parts.push(`All updates from: ${params.min_apion}`);
    }

    return parts.length > 0 ? parts.join(', ') : 'No filters applied';
  }
}

module.exports = new DropdownDataService();