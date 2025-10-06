import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ToastrService } from 'ngx-toastr';
import { CustomerService } from '../../services/customer.service';
import { ApiFilteringService, FilteringParams, DropdownData, ProjectPreview } from '../../services/api-filtering.service';

interface Drive {
  name: string;
  path: string;
  type: string;
}

interface FileSystemItem {
  name: string;
  path: string;
  type: string;
  isDirectory: boolean;
  pdfCount?: number;
  size?: number;
  modified?: Date;
}

interface LocalProject {
  projectId: string;
  folderName: string;
  path: string;
  pdfCount: number;
  pdfFiles: string[];
  sampleDocuments: string[];
  displayName: string;
  hasMetadata: boolean;
  metadata?: any;
}

interface AWSFolder {
  name: string;
  prefix: string;
  type: string;
}

interface AWSProject {
  projectId: string;
  pdfCount: number;
  displayName: string;
  hasMetadata: boolean;
  metadata?: any;
  sampleDocuments: string[];
  folderPath?: string;
  parentFolder?: string;
}

@Component({
  selector: 'app-documents-browser',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="documents-container">
      <div class="documents-header">
        <h1>Documents Management</h1>
        <p>Browse and select documents for FI processing</p>
      </div>

      <!-- Tab Navigation -->
      <div class="tab-navigation">
        <button
          class="tab-button"
          [class.active]="activeTab === 'aws'"
          (click)="setActiveTab('aws')"
        >
          <i class="icon-cloud"></i> AWS S3 Documents
        </button>
        <button
          class="tab-button"
          [class.active]="activeTab === 'local'"
          (click)="setActiveTab('local')"
        >
          <i class="icon-folder"></i> Local Documents
        </button>
      </div>

      <!-- AWS S3 Tab -->
      <div class="tab-content" *ngIf="activeTab === 'aws'">
        <div class="aws-controls">
          <div class="stats-bar">
            <div class="stat" *ngIf="awsStats">
              <span class="stat-value">{{awsStats.totalProjects}}</span>
              <span class="stat-label">Total Projects</span>
            </div>
            <div class="stat" *ngIf="awsStats">
              <span class="stat-value">{{awsStats.estimatedTotalDocuments}}</span>
              <span class="stat-label">Est. Documents</span>
            </div>
            <button class="refresh-btn" (click)="showingFolders ? loadAWSFolders() : loadProjectsInFolder(selectedAWSFolder)">
              <i class="icon-refresh"></i> Refresh
            </button>
            <button class="back-btn" *ngIf="!showingFolders" (click)="backToFolders()">
              <i class="icon-back"></i> Back to Folders
            </button>
            <button class="filter-btn" (click)="toggleApiFiltering()" [class.active]="showApiFiltering">
              <i class="icon-filter"></i> API Filtering
            </button>
          </div>

          <!-- API Filtering Controls -->
          <div class="api-filtering-section" *ngIf="showApiFiltering">
            <div class="filtering-header">
              <h3>Filter Projects via Building Info API</h3>
              <p>Filter projects by category, county, stage, and type before processing planning-docs only</p>
            </div>

            <div class="filtering-controls" *ngIf="dropdownData">
              <div class="filter-row">
                <div class="filter-group">
                  <label>Category:</label>
                  <select [(ngModel)]="selectedFilters.category" (change)="onCategoryChange()">
                    <option value="">All Categories</option>
                    <option *ngFor="let cat of dropdownData.categories" [value]="cat.id">{{cat.name}}</option>
                  </select>
                </div>

                <div class="filter-group">
                  <label>Subcategory:</label>
                  <select [(ngModel)]="selectedFilters.subcategory" [disabled]="!selectedFilters.category">
                    <option value="">All Subcategories</option>
                    <option
                      *ngFor="let subcat of getSubcategoriesForCategory(selectedFilters.category)"
                      [value]="subcat.id"
                    >{{subcat.name}}</option>
                  </select>
                </div>

                <div class="filter-group">
                  <label>County:</label>
                  <select [(ngModel)]="selectedFilters.county">
                    <option value="">All Counties</option>
                    <option *ngFor="let county of dropdownData.counties" [value]="county.id">{{county.name}}</option>
                  </select>
                </div>

                <div class="filter-group">
                  <label>Date Filter:</label>
                  <select [(ngModel)]="selectedFilters.apion" (change)="onDateFilterChange()">
                    <option value="">All Time</option>
                    <option value="3">Today</option>
                    <option value="-1.1">Yesterday</option>
                    <option value="0.7">Past 7 Days</option>
                    <option value="1">Past 30 Days</option>
                    <option value="1.1">Past 3 Months</option>
                    <option value="2">Past 12 Months</option>
                    <option value="3.1">Current Year</option>
                    <option value="8">Custom Date Range</option>
                  </select>
                </div>
              </div>

              <!-- Custom Date Range Row (only shown when Custom Date Range is selected) -->
              <div class="filter-row" *ngIf="selectedFilters.apion === '8'">
                <div class="filter-group">
                  <label>From Date:</label>
                  <input type="date" [(ngModel)]="selectedFilters.min_apion" placeholder="Start Date (YYYY-MM-DD)">
                </div>

                <div class="filter-group">
                  <label>To Date:</label>
                  <input type="date" [(ngModel)]="selectedFilters.max_apion" placeholder="End Date (YYYY-MM-DD)">
                </div>
              </div>

              <div class="filter-row">
                <div class="filter-group">
                  <label>Stage:</label>
                  <select [(ngModel)]="selectedFilters.stage">
                    <option value="">All Stages</option>
                    <option *ngFor="let stage of dropdownData.stages" [value]="stage.id">{{stage.name}}</option>
                  </select>
                </div>

                <div class="filter-group">
                  <label>Type:</label>
                  <select [(ngModel)]="selectedFilters.type">
                    <option value="">All Types</option>
                    <option *ngFor="let type of dropdownData.types" [value]="type.id">{{type.name}}</option>
                  </select>
                </div>

                <div class="filter-actions">
                  <button class="preview-btn" (click)="previewFilteredProjects()" [disabled]="loadingPreview">
                    <span *ngIf="!loadingPreview">Preview Projects</span>
                    <span *ngIf="loadingPreview">Loading...</span>
                  </button>
                  <button class="clear-btn" (click)="clearFilters()">Clear Filters</button>
                </div>
              </div>
            </div>

            <!-- Filter Validation -->
            <div class="filter-validation" *ngIf="filterValidation">
              <div class="validation-errors" *ngIf="filterValidation.errors?.length > 0">
                <h4>Validation Errors:</h4>
                <ul>
                  <li *ngFor="let error of filterValidation.errors">{{error}}</li>
                </ul>
              </div>
              <div class="validation-warnings" *ngIf="filterValidation.warnings?.length > 0">
                <h4>Warnings:</h4>
                <ul>
                  <li *ngFor="let warning of filterValidation.warnings">{{warning}}</li>
                </ul>
              </div>
            </div>

            <!-- Project Preview -->
            <div class="project-preview" *ngIf="previewedProjects && previewedProjects.length > 0">
              <h4>Preview Results ({{previewedProjects.length}} projects)</h4>
              <div class="preview-grid">
                <div class="preview-item" *ngFor="let project of previewedProjects.slice(0, 10)">
                  <div class="preview-id">{{project.projectId}}</div>
                  <div class="preview-title">{{project.title}}</div>
                  <div class="preview-details">
                    <span>{{project.category}}</span> •
                    <span>{{project.county}}</span> •
                    <span>{{project.stage}}</span>
                  </div>
                </div>
              </div>

              <!-- Customer Selection for Filtered Projects -->
              <div class="filtered-customer-selection" *ngIf="previewedProjects.length > 0">

                <!-- Report Type Selection -->
                <div class="report-type-selection">
                  <h4>Select Report Types</h4>
                  <div class="checkbox-group">
                    <label class="checkbox-label" *ngFor="let type of reportTypes">
                      <input
                        type="checkbox"
                        [(ngModel)]="type.selected"
                      > {{type.name}}
                    </label>
                  </div>
                  <p class="report-requirement" *ngIf="!hasSelectedReportTypes()">
                    Please select at least one report type
                  </p>
                </div>

                <!-- Customer Selection -->
                <div class="customer-selection-section">
                  <h4>Select Customers for Processing</h4>

                  <!-- Selected Customers Display -->
                  <div class="selected-customers" *ngIf="selectedCustomers.length > 0">
                    <h5>Selected Customers ({{ selectedCustomers.length }})</h5>
                    <div class="customer-list">
                      <div class="customer-item" *ngFor="let customer of selectedCustomers; let i = index">
                        <div class="customer-info">
                          <span class="customer-name">{{ customer.name }}</span>
                          <span class="customer-email">{{ customer.email }}</span>
                        </div>
                        <button class="remove-btn" (click)="removeSelectedCustomer(i)">✕</button>
                      </div>
                    </div>
                  </div>

                  <!-- Customer Action Buttons -->
                  <div class="customer-actions">
                    <button class="btn btn-primary" (click)="openAddCustomerModal()">
                      ➕ Add New Customer
                    </button>
                    <button class="btn btn-secondary" *ngIf="selectedCustomers.length > 0" (click)="clearAllCustomers()">
                      🗑️ Clear All
                    </button>
                  </div>

                  <!-- Quick Select Existing Customers -->
                  <div class="existing-customers" *ngIf="existingCustomers.length > 0">
                    <h5>Quick Select from Existing:</h5>
                    <div class="existing-customer-list">
                      <button
                        class="existing-customer-btn"
                        *ngFor="let customer of existingCustomers.slice(0, 5)"
                        (click)="selectExistingCustomer(customer)"
                      >
                        {{ customer.name }} ({{ customer.email }})
                      </button>
                    </div>
                  </div>

                  <p class="customer-requirement" *ngIf="selectedCustomers.length === 0">
                    Please select at least one customer to proceed
                  </p>
                </div>
              </div>

              <div class="preview-actions" *ngIf="previewedProjects.length > 0">
                <button class="process-filtered-btn" (click)="processFIWithApiFilters()" [disabled]="processingWithFilters || selectedCustomers.length === 0 || !hasSelectedReportTypes()">
                  <span *ngIf="!processingWithFilters">Process FI Detection ({{ selectedCustomers.length }} customer{{ selectedCustomers.length !== 1 ? 's' : '' }}, {{ getSelectedReportTypesCount() }} report type{{ getSelectedReportTypesCount() !== 1 ? 's' : '' }})</span>
                  <span *ngIf="processingWithFilters">Processing...</span>
                </button>
                <div class="requirements" *ngIf="selectedCustomers.length === 0 || !hasSelectedReportTypes()">
                  <p class="customer-requirement" *ngIf="selectedCustomers.length === 0">
                    Please select at least one customer
                  </p>
                  <p class="report-requirement" *ngIf="!hasSelectedReportTypes()">
                    Please select at least one report type
                  </p>
                </div>
              </div>
            </div>

            <!-- Loading States -->
            <div class="loading-state" *ngIf="loadingFilters">
              <div class="spinner"></div>
              <p>Loading filter options...</p>
            </div>
          </div>

          <div class="breadcrumb" *ngIf="!showingFolders">
            <span class="breadcrumb-item" (click)="backToFolders()">AWS S3</span>
            <span class="breadcrumb-separator">></span>
            <span class="breadcrumb-item active">{{selectedAWSFolder}}</span>
          </div>

          <div class="search-controls" *ngIf="!showingFolders">
            <input
              type="text"
              [(ngModel)]="awsSearchTerm"
              placeholder="Search projects by ID or title..."
              class="search-input"
              (input)="filterAWSProjects()"
            >
            <select [(ngModel)]="awsSortBy" (change)="sortAWSProjects()" class="sort-select">
              <option value="projectId">Sort by Project ID</option>
              <option value="title">Sort by Title</option>
              <option value="pdfCount">Sort by Document Count</option>
            </select>
          </div>
        </div>

        <!-- Folder Grid -->
        <div class="folders-grid" *ngIf="showingFolders && !loadingAWS">
          <div
            class="folder-card"
            *ngFor="let folder of awsFolders"
            [class.selected]="selectedAWSFolders.has(folder.name)"
          >
            <div class="folder-checkbox">
              <input
                type="checkbox"
                [checked]="selectedAWSFolders.has(folder.name)"
                (change)="toggleFolderSelection(folder.name)"
                (click)="$event.stopPropagation()"
              >
            </div>
            <div class="folder-content" (click)="loadProjectsInFolder(folder.name)">
              <div class="folder-icon">📁</div>
              <div class="folder-name">{{folder.name}}</div>
              <div class="folder-type">AWS S3 Folder</div>
            </div>
            <div class="folder-actions">
              <button
                class="process-folder-btn"
                (click)="processSingleFolder(folder.name); $event.stopPropagation()"
                [disabled]="!canProcessFolders()"
              >
                Process All
              </button>
            </div>
          </div>
        </div>

        <!-- Folder Processing Controls -->
        <div class="folder-processing-controls" *ngIf="showingFolders && selectedAWSFolders.size > 0">
          <div class="selection-summary">
            <strong>Selected Folders:</strong> {{selectedAWSFolders.size}}
            <span class="folder-list">({{Array.from(selectedAWSFolders).join(', ')}})</span>
          </div>

          <div class="fi-processing-form">
            <div class="form-row">
              <label>Report Types:</label>
              <div class="checkbox-group">
                <label class="checkbox-label" *ngFor="let type of reportTypes">
                  <input
                    type="checkbox"
                    [(ngModel)]="type.selected"
                  > {{type.name}}
                </label>
              </div>
            </div>

            <div class="form-row">
              <label>Customer Management:</label>

              <!-- Selected Customers Display -->
              <div class="selected-customers" *ngIf="selectedCustomers.length > 0">
                <h4>Selected Customers ({{ selectedCustomers.length }})</h4>
                <div class="customer-list">
                  <div class="customer-item" *ngFor="let customer of selectedCustomers; let i = index">
                    <div class="customer-info">
                      <span class="customer-name">{{ customer.name }}</span>
                      <span class="customer-email">{{ customer.email }}</span>
                    </div>
                    <button class="remove-btn" (click)="removeSelectedCustomer(i)">✕</button>
                  </div>
                </div>
              </div>

              <!-- Customer Action Buttons -->
              <div class="customer-actions">
                <button class="btn btn-primary" (click)="openAddCustomerModal()">
                  ➕ Add New Customer
                </button>
                <button class="btn btn-secondary" *ngIf="selectedCustomers.length > 0" (click)="clearAllCustomers()">
                  🗑️ Clear All
                </button>
              </div>

              <!-- Quick Select Existing Customers -->
              <div class="existing-customers" *ngIf="existingCustomers.length > 0">
                <h4>Quick Select from Existing:</h4>
                <div class="existing-customer-list">
                  <button
                    class="existing-customer-btn"
                    *ngFor="let customer of existingCustomers.slice(0, 5)"
                    (click)="selectExistingCustomer(customer)"
                  >
                    {{ customer.name }} ({{ customer.email }})
                  </button>
                </div>
              </div>
            </div>

            <div class="action-buttons">
              <button
                class="process-btn primary"
                (click)="processSelectedFolders()"
                [disabled]="!canProcessFolders()"
              >
                <i class="icon-play"></i>
                Process {{selectedAWSFolders.size}} Folder(s) - All Projects
              </button>
              <button class="clear-btn" (click)="clearFolderSelections()">
                Clear Selections
              </button>
            </div>
          </div>
        </div>

        <!-- Projects Grid -->
        <div class="projects-grid" *ngIf="!showingFolders && !loadingAWS">
          <div
            class="project-card"
            *ngFor="let project of filteredAWSProjects"
            [class.selected]="selectedAWSProjects.has(project.projectId)"
            (click)="toggleAWSProjectSelection(project)"
          >
            <div class="project-header">
              <div class="project-id">{{project.projectId}}</div>
              <div class="document-count">{{project.pdfCount}} PDFs</div>
            </div>
            <div class="project-title">{{project.displayName}}</div>
            <div class="project-details" *ngIf="project.hasMetadata">
              <div class="detail-item">
                <strong>Authority:</strong> {{project.metadata.planning_authority}}
              </div>
              <div class="detail-item">
                <strong>Stage:</strong> {{project.metadata.planning_stage}}
              </div>
              <div class="detail-item">
                <strong>Updated:</strong> {{project.metadata.planning_updated}}
              </div>
            </div>
            <div class="project-note" *ngIf="!project.hasMetadata">
              <small>Metadata will be loaded when FI matches are found</small>
            </div>
            <div class="sample-files" *ngIf="project.sampleDocuments.length > 0">
              <strong>Sample files:</strong>
              <ul>
                <li *ngFor="let file of project.sampleDocuments.slice(0, 3)">{{file}}</li>
                <li *ngIf="project.pdfCount > 3">...and {{project.pdfCount - 3}} more</li>
              </ul>
            </div>
            <div class="selection-indicator" *ngIf="selectedAWSProjects.has(project.projectId)">
              ✓ Selected
            </div>
          </div>
        </div>

        <div class="loading-state" *ngIf="loadingAWS">
          <div class="spinner"></div>
          <p>{{showingFolders ? 'Loading AWS folders...' : 'Loading projects...'}}</p>
        </div>

        <div class="pagination" *ngIf="awsPagination && !loadingAWS && !showingFolders">
          <button
            class="page-btn"
            [disabled]="awsPagination.offset === 0"
            (click)="loadProjectsInFolder(selectedAWSFolder, awsPagination.offset - awsPagination.limit)"
          >
            Previous
          </button>
          <span class="page-info">
            {{awsPagination.offset + 1}} - {{Math.min(awsPagination.offset + awsPagination.limit, awsPagination.total)}}
            of {{awsPagination.total}}
          </span>
          <button
            class="page-btn"
            [disabled]="!awsPagination.hasMore"
            (click)="loadProjectsInFolder(selectedAWSFolder, awsPagination.offset + awsPagination.limit)"
          >
            Next
          </button>
        </div>
      </div>

      <!-- Local Documents Tab -->
      <div class="tab-content" *ngIf="activeTab === 'local'">
        <div class="local-controls">
          <div class="path-navigation">
            <select [(ngModel)]="selectedDrive" (change)="browseLocalPath(selectedDrive)" class="drive-select">
              <option value="">Select Drive...</option>
              <option *ngFor="let drive of availableDrives" [value]="drive.path">
                {{drive.name}} ({{drive.type}})
              </option>
            </select>
            <div class="current-path" *ngIf="currentLocalPath">
              <strong>Current:</strong> {{currentLocalPath}}
            </div>
          </div>

          <div class="local-actions">
            <button class="scan-btn" (click)="scanForProjects()" [disabled]="!currentLocalPath">
              <i class="icon-search"></i> Scan for Projects
            </button>
            <button class="folder-btn" (click)="showFolderBrowser = !showFolderBrowser">
              <i class="icon-folder"></i> Browse Folders
            </button>
          </div>
        </div>

        <!-- Folder Browser -->
        <div class="folder-browser" *ngIf="showFolderBrowser">
          <div class="browser-header">
            <h3>Folder Browser</h3>
            <button class="close-btn" (click)="showFolderBrowser = false">×</button>
          </div>

          <div class="file-list">
            <div
              class="file-item"
              *ngFor="let item of localFileItems"
              [class.directory]="item.isDirectory"
              [class.pdf]="item.type === 'pdf'"
              (click)="item.isDirectory ? browseLocalPath(item.path) : null"
              [class.clickable]="item.isDirectory"
            >
              <div class="file-icon">
                <span *ngIf="item.type === 'parent'">↰</span>
                <span *ngIf="item.type === 'directory'">📁</span>
                <span *ngIf="item.type === 'pdf'">📄</span>
              </div>
              <div class="file-details">
                <div class="file-name">{{item.name}}</div>
                <div class="file-info" *ngIf="item.type === 'directory' && item.pdfCount">
                  {{item.pdfCount}} PDF files
                </div>
                <div class="file-info" *ngIf="item.type === 'pdf'">
                  {{formatFileSize(item.size || 0)}}
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Local Folder Processing Controls -->
        <div class="local-folder-processing-controls" *ngIf="localProjects.length > 0">
          <div class="folder-processing-header">
            <h3>Process Local Folder</h3>
            <p>Process all projects in the current folder for FI detection</p>
          </div>

          <div class="folder-processing-form">
            <div class="form-row">
              <label>Report Types:</label>
              <div class="checkbox-group">
                <label class="checkbox-label" *ngFor="let type of reportTypes">
                  <input
                    type="checkbox"
                    [(ngModel)]="type.selected"
                  > {{type.name}}
                </label>
              </div>
            </div>

            <div class="form-row">
              <label>Customer Management:</label>

              <!-- Selected Customers Display -->
              <div class="selected-customers" *ngIf="selectedCustomers.length > 0">
                <h4>Selected Customers ({{ selectedCustomers.length }})</h4>
                <div class="customer-list">
                  <div class="customer-item" *ngFor="let customer of selectedCustomers; let i = index">
                    <div class="customer-info">
                      <span class="customer-name">{{ customer.name }}</span>
                      <span class="customer-email">{{ customer.email }}</span>
                    </div>
                    <button class="remove-btn" (click)="removeSelectedCustomer(i)">✕</button>
                  </div>
                </div>
              </div>

              <!-- Customer Action Buttons -->
              <div class="customer-actions">
                <button class="btn btn-primary" (click)="openAddCustomerModal()">
                  ➕ Add New Customer
                </button>
                <button class="btn btn-secondary" *ngIf="selectedCustomers.length > 0" (click)="clearAllCustomers()">
                  🗑️ Clear All
                </button>
              </div>

              <!-- Quick Select Existing Customers -->
              <div class="existing-customers" *ngIf="existingCustomers.length > 0">
                <h4>Quick Select from Existing:</h4>
                <div class="existing-customer-list">
                  <button
                    class="existing-customer-btn"
                    *ngFor="let customer of existingCustomers.slice(0, 5)"
                    (click)="selectExistingCustomer(customer)"
                  >
                    {{ customer.name }} ({{ customer.email }})
                  </button>
                </div>
              </div>
            </div>

            <div class="action-buttons">
              <button
                class="process-btn primary"
                (click)="processCurrentLocalFolder()"
                [disabled]="!canProcessLocalFolder()"
              >
                <i class="icon-play"></i>
                Process Entire Folder ({{localProjects.length}} Projects)
              </button>
              <button class="clear-btn" (click)="clearLocalSelections()">
                Clear Selections
              </button>
            </div>
          </div>
        </div>

        <!-- Local Projects Display -->
        <div class="local-projects" *ngIf="localProjects.length > 0">
          <h3>Found Projects ({{localProjects.length}}) - Select Individual Projects</h3>
          <div class="projects-grid">
            <div
              class="project-card"
              *ngFor="let project of localProjects"
              [class.selected]="selectedLocalProjects.has(project.projectId)"
              (click)="toggleLocalProjectSelection(project)"
            >
              <div class="project-header">
                <div class="project-id">{{project.projectId}}</div>
                <div class="document-count">{{project.pdfCount}} PDFs</div>
              </div>
              <div class="project-title">{{project.displayName}}</div>
              <div class="project-path">{{project.path}}</div>
              <div class="project-note" *ngIf="!project.hasMetadata">
                <small>Metadata will be loaded when FI matches are found</small>
              </div>
              <div class="sample-files" *ngIf="project.sampleDocuments && project.sampleDocuments.length > 0">
                <strong>Sample files:</strong>
                <ul>
                  <li *ngFor="let file of project.sampleDocuments.slice(0, 3)">{{file}}</li>
                  <li *ngIf="project.pdfCount > 3">...and {{project.pdfCount - 3}} more</li>
                </ul>
              </div>
              <div class="selection-indicator" *ngIf="selectedLocalProjects.has(project.projectId)">
                ✓ Selected
              </div>
            </div>
          </div>
        </div>

        <div class="no-projects" *ngIf="localProjects.length === 0 && !loadingLocal">
          <p>No projects found. Use "Scan for Projects" to search for project folders in the current directory.</p>
        </div>
      </div>

      <!-- Processing Controls -->
      <div class="processing-controls" *ngIf="hasSelections()">
        <div class="selection-summary">
          <strong>Selected:</strong>
          <span *ngIf="selectedAWSProjects.size > 0">{{selectedAWSProjects.size}} AWS projects</span>
          <span *ngIf="selectedLocalProjects.size > 0">{{selectedLocalProjects.size}} local projects</span>
        </div>

        <div class="fi-processing-form">
          <div class="form-row">
            <label>Report Types:</label>
            <div class="checkbox-group">
              <label class="checkbox-label" *ngFor="let type of reportTypes">
                <input
                  type="checkbox"
                  [(ngModel)]="type.selected"
                > {{type.name}}
              </label>
            </div>
          </div>

          <div class="form-row">
            <label>Customer Management:</label>

            <!-- Selected Customers Display -->
            <div class="selected-customers" *ngIf="selectedCustomers.length > 0">
              <h4>Selected Customers ({{ selectedCustomers.length }})</h4>
              <div class="customer-list">
                <div class="customer-item" *ngFor="let customer of selectedCustomers; let i = index">
                  <div class="customer-info">
                    <span class="customer-name">{{ customer.name }}</span>
                    <span class="customer-email">{{ customer.email }}</span>
                  </div>
                  <button class="remove-btn" (click)="removeSelectedCustomer(i)">✕</button>
                </div>
              </div>
            </div>

            <!-- Customer Action Buttons -->
            <div class="customer-actions">
              <button class="btn btn-primary" (click)="openAddCustomerModal()">
                ➕ Add New Customer
              </button>
              <button class="btn btn-secondary" *ngIf="selectedCustomers.length > 0" (click)="clearAllCustomers()">
                🗑️ Clear All
              </button>
            </div>

            <!-- Quick Select Existing Customers -->
            <div class="existing-customers" *ngIf="existingCustomers.length > 0">
              <h4>Quick Select from Existing:</h4>
              <div class="existing-customer-list">
                <button
                  class="existing-customer-btn"
                  *ngFor="let customer of existingCustomers.slice(0, 5)"
                  (click)="selectExistingCustomer(customer)"
                >
                  {{ customer.name }} ({{ customer.email }})
                </button>
              </div>
            </div>
          </div>

          <div class="form-row">
            <label>Processing Options:</label>
            <div class="radio-group">
              <label class="radio-label">
                <input type="radio" [(ngModel)]="processingMode" value="immediate">
                Process Immediately
              </label>
              <label class="radio-label">
                <input type="radio" [(ngModel)]="processingMode" value="scheduled">
                Schedule for Later
              </label>
            </div>
          </div>

          <div class="form-row" *ngIf="processingMode === 'scheduled'">
            <label>Schedule Time:</label>
            <input
              type="datetime-local"
              [(ngModel)]="scheduleTime"
              class="datetime-input"
            >
          </div>

          <div class="action-buttons">
            <button
              class="process-btn primary"
              (click)="startFIProcessing()"
              [disabled]="!canStartProcessing()"
            >
              <i class="icon-play"></i>
              {{processingMode === 'immediate' ? 'Start Processing' : 'Schedule Processing'}}
            </button>
            <button class="clear-btn" (click)="clearSelections()">
              Clear Selections
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Add Customer Modal -->
    <div class="modal" *ngIf="showAddCustomerModal" (click)="closeAddCustomerModal()">
      <div class="modal-content" (click)="$event.stopPropagation()">
        <div class="modal-header">
          <h2>Add New Customer</h2>
          <span class="close" (click)="closeAddCustomerModal()">&times;</span>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label for="customerName">Customer Name:</label>
            <input
              id="customerName"
              type="text"
              [(ngModel)]="newCustomer.name"
              placeholder="Enter customer name"
              class="form-input"
            >
          </div>
          <div class="form-group">
            <label for="customerEmail">Email Address:</label>
            <input
              id="customerEmail"
              type="email"
              [(ngModel)]="newCustomer.email"
              placeholder="customer@example.com"
              class="form-input"
            >
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" (click)="closeAddCustomerModal()">Cancel</button>
          <button class="btn btn-primary" (click)="addNewCustomer()">Add Customer</button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .documents-container {
      padding: 20px;
      max-width: 1400px;
      margin: 0 auto;
    }

    .documents-header {
      margin-bottom: 30px;
    }

    .documents-header h1 {
      color: #2c3e50;
      margin-bottom: 5px;
    }

    .tab-navigation {
      display: flex;
      border-bottom: 2px solid #ecf0f1;
      margin-bottom: 30px;
    }

    .tab-button {
      padding: 12px 24px;
      border: none;
      background: none;
      cursor: pointer;
      font-size: 16px;
      color: #7f8c8d;
      border-bottom: 3px solid transparent;
      transition: all 0.3s ease;
    }

    .tab-button:hover {
      color: #2c3e50;
    }

    .tab-button.active {
      color: #3498db;
      border-bottom-color: #3498db;
    }

    .tab-button i {
      margin-right: 8px;
    }

    .aws-controls, .local-controls {
      background: #f8f9fa;
      padding: 20px;
      border-radius: 8px;
      margin-bottom: 20px;
    }

    .stats-bar {
      display: flex;
      align-items: center;
      gap: 30px;
      margin-bottom: 15px;
    }

    .stat {
      text-align: center;
    }

    .stat-value {
      display: block;
      font-size: 24px;
      font-weight: bold;
      color: #2c3e50;
    }

    .stat-label {
      font-size: 12px;
      color: #7f8c8d;
      text-transform: uppercase;
    }

    .refresh-btn, .scan-btn, .folder-btn, .back-btn, .filter-btn {
      padding: 8px 16px;
      background: #3498db;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      margin-right: 10px;
    }

    .refresh-btn:hover, .scan-btn:hover, .folder-btn:hover, .back-btn:hover, .filter-btn:hover {
      background: #2980b9;
    }

    .filter-btn.active {
      background: #27ae60;
    }

    .filter-btn.active:hover {
      background: #229954;
    }

    .back-btn {
      background: #95a5a6;
    }

    .back-btn:hover {
      background: #7f8c8d;
    }

    .search-controls {
      display: flex;
      gap: 15px;
      align-items: center;
    }

    .search-input {
      flex: 1;
      padding: 10px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 14px;
    }

    .sort-select, .drive-select {
      padding: 10px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 14px;
    }

    .path-navigation {
      display: flex;
      align-items: center;
      gap: 20px;
      margin-bottom: 15px;
    }

    .current-path {
      font-size: 14px;
      color: #7f8c8d;
    }

    .local-actions {
      display: flex;
      gap: 10px;
    }

    .folder-browser {
      background: white;
      border: 1px solid #ddd;
      border-radius: 8px;
      margin-bottom: 20px;
      max-height: 400px;
      overflow-y: auto;
    }

    .browser-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 15px;
      border-bottom: 1px solid #eee;
      background: #f8f9fa;
    }

    .close-btn {
      background: none;
      border: none;
      font-size: 20px;
      cursor: pointer;
      color: #999;
    }

    .file-list {
      padding: 10px;
    }

    .file-item {
      display: flex;
      align-items: center;
      padding: 10px;
      border-radius: 4px;
      margin-bottom: 2px;
    }

    .file-item.clickable {
      cursor: pointer;
    }

    .file-item.clickable:hover {
      background: #f0f0f0;
    }

    .file-icon {
      margin-right: 12px;
      font-size: 18px;
    }

    .file-details {
      flex: 1;
    }

    .file-name {
      font-weight: 500;
      margin-bottom: 2px;
    }

    .file-info {
      font-size: 12px;
      color: #7f8c8d;
    }

    .breadcrumb {
      margin-bottom: 20px;
      padding: 10px 0;
      font-size: 14px;
    }

    .breadcrumb-item {
      color: #3498db;
      cursor: pointer;
    }

    .breadcrumb-item:hover {
      text-decoration: underline;
    }

    .breadcrumb-item.active {
      color: #2c3e50;
      cursor: default;
    }

    .breadcrumb-separator {
      margin: 0 10px;
      color: #7f8c8d;
    }

    .folders-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
      gap: 20px;
      margin-top: 20px;
    }

    .folder-card {
      background: white;
      border: 2px solid #ecf0f1;
      border-radius: 8px;
      padding: 15px;
      transition: all 0.3s ease;
      position: relative;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .folder-card:hover {
      border-color: #3498db;
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.1);
    }

    .folder-card.selected {
      border-color: #27ae60;
      background: #f0fff4;
    }

    .folder-checkbox {
      position: absolute;
      top: 10px;
      left: 10px;
      z-index: 2;
    }

    .folder-checkbox input[type="checkbox"] {
      width: 18px;
      height: 18px;
      cursor: pointer;
    }

    .folder-content {
      text-align: center;
      cursor: pointer;
      padding: 20px 10px 10px;
    }

    .folder-icon {
      font-size: 48px;
      margin-bottom: 15px;
    }

    .folder-name {
      font-size: 16px;
      font-weight: bold;
      color: #2c3e50;
      margin-bottom: 5px;
    }

    .folder-type {
      font-size: 12px;
      color: #7f8c8d;
    }

    .folder-actions {
      display: flex;
      justify-content: center;
      margin-top: auto;
    }

    .process-folder-btn {
      padding: 8px 16px;
      background: #27ae60;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
    }

    .process-folder-btn:hover:not(:disabled) {
      background: #229954;
    }

    .process-folder-btn:disabled {
      background: #bdc3c7;
      cursor: not-allowed;
    }

    .folder-processing-controls {
      background: #f8f9fa;
      border: 2px solid #27ae60;
      border-radius: 8px;
      padding: 25px;
      margin-top: 20px;
    }

    .folder-list {
      font-size: 14px;
      color: #7f8c8d;
      font-style: italic;
    }

    .projects-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
      gap: 20px;
      margin-top: 20px;
    }

    .project-card {
      background: white;
      border: 2px solid #ecf0f1;
      border-radius: 8px;
      padding: 20px;
      cursor: pointer;
      transition: all 0.3s ease;
      position: relative;
    }

    .project-card:hover {
      border-color: #3498db;
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.1);
    }

    .project-card.selected {
      border-color: #27ae60;
      background: #f0fff4;
    }

    .project-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }

    .project-id {
      font-size: 18px;
      font-weight: bold;
      color: #2c3e50;
    }

    .document-count {
      background: #3498db;
      color: white;
      padding: 4px 8px;
      border-radius: 12px;
      font-size: 12px;
    }

    .project-title {
      font-size: 16px;
      margin-bottom: 15px;
      color: #2c3e50;
      line-height: 1.4;
    }

    .project-details {
      margin-bottom: 15px;
    }

    .detail-item {
      font-size: 13px;
      margin-bottom: 5px;
      color: #7f8c8d;
    }

    .project-note {
      margin-bottom: 15px;
      padding: 8px;
      background: #f8f9fa;
      border-radius: 4px;
      border-left: 3px solid #3498db;
    }

    .project-note small {
      color: #7f8c8d;
      font-style: italic;
    }

    .project-path {
      font-size: 12px;
      color: #95a5a6;
      margin-bottom: 10px;
      font-family: monospace;
    }

    .sample-files {
      font-size: 13px;
    }

    .sample-files ul {
      margin: 5px 0 0 0;
      padding-left: 20px;
    }

    .sample-files li {
      font-size: 12px;
      color: #7f8c8d;
      margin-bottom: 2px;
    }

    .selection-indicator {
      position: absolute;
      top: 10px;
      right: 10px;
      background: #27ae60;
      color: white;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: bold;
    }

    .loading-state {
      text-align: center;
      padding: 40px;
    }

    .spinner {
      border: 4px solid #f3f3f3;
      border-top: 4px solid #3498db;
      border-radius: 50%;
      width: 40px;
      height: 40px;
      animation: spin 1s linear infinite;
      margin: 0 auto 20px;
    }

    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }

    .pagination {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 20px;
      margin-top: 30px;
    }

    .page-btn {
      padding: 10px 20px;
      background: #3498db;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }

    .page-btn:disabled {
      background: #bdc3c7;
      cursor: not-allowed;
    }

    .page-info {
      font-size: 14px;
      color: #7f8c8d;
    }

    .local-folder-processing-controls {
      background: #e8f5e8;
      border: 2px solid #27ae60;
      border-radius: 8px;
      padding: 25px;
      margin-bottom: 30px;
    }

    .folder-processing-header {
      margin-bottom: 20px;
    }

    .folder-processing-header h3 {
      color: #27ae60;
      margin-bottom: 5px;
    }

    .folder-processing-header p {
      color: #7f8c8d;
      margin: 0;
    }

    .folder-processing-form .form-row {
      margin-bottom: 20px;
    }

    .folder-processing-form label {
      display: block;
      font-weight: 500;
      margin-bottom: 8px;
      color: #2c3e50;
    }

    .processing-controls {
      background: #f8f9fa;
      border: 2px solid #3498db;
      border-radius: 8px;
      padding: 25px;
      margin-top: 30px;
    }

    .selection-summary {
      margin-bottom: 20px;
      font-size: 16px;
    }

    .fi-processing-form .form-row {
      margin-bottom: 20px;
    }

    .fi-processing-form label {
      display: block;
      font-weight: 500;
      margin-bottom: 8px;
      color: #2c3e50;
    }

    .checkbox-group, .radio-group {
      display: flex;
      gap: 20px;
      flex-wrap: wrap;
    }

    .checkbox-label, .radio-label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: normal;
    }

    .email-input {
      width: 100%;
      min-height: 80px;
      padding: 10px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 14px;
      resize: vertical;
    }

    .datetime-input {
      padding: 10px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 14px;
    }

    .action-buttons {
      display: flex;
      gap: 15px;
      margin-top: 25px;
    }

    .process-btn, .clear-btn {
      padding: 12px 24px;
      border: none;
      border-radius: 6px;
      font-size: 16px;
      cursor: pointer;
      font-weight: 500;
      transition: all 0.3s ease;
    }

    .process-btn.primary {
      background: #27ae60;
      color: white;
    }

    .process-btn.primary:hover:not(:disabled) {
      background: #229954;
    }

    .process-btn:disabled {
      background: #bdc3c7;
      cursor: not-allowed;
    }

    .clear-btn {
      background: #95a5a6;
      color: white;
    }

    .clear-btn:hover {
      background: #7f8c8d;
    }

    .no-projects {
      text-align: center;
      padding: 40px;
      color: #7f8c8d;
    }

    /* Customer Management Styles */
    .selected-customers {
      margin: 15px 0;
    }

    .selected-customers h4 {
      margin-bottom: 10px;
      color: #333;
      font-size: 14px;
    }

    .customer-list {
      border: 1px solid #ddd;
      border-radius: 4px;
      max-height: 200px;
      overflow-y: auto;
    }

    .customer-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 12px;
      border-bottom: 1px solid #eee;
    }

    .customer-item:last-child {
      border-bottom: none;
    }

    .customer-info {
      display: flex;
      flex-direction: column;
    }

    .customer-name {
      font-weight: 500;
      color: #333;
      font-size: 13px;
    }

    .customer-email {
      color: #666;
      font-size: 11px;
    }

    .remove-btn {
      background: #ff4757;
      color: white;
      border: none;
      border-radius: 50%;
      width: 20px;
      height: 20px;
      cursor: pointer;
      font-size: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .remove-btn:hover {
      background: #ff3838;
    }

    .customer-actions {
      display: flex;
      gap: 10px;
      margin: 10px 0;
    }

    .customer-actions .btn {
      padding: 8px 12px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 5px;
    }

    .customer-actions .btn-primary {
      background: #667eea;
      color: white;
    }

    .customer-actions .btn-primary:hover {
      background: #5a67d8;
    }

    .customer-actions .btn-secondary {
      background: #f8f9fa;
      color: #666;
      border: 1px solid #ddd;
    }

    .customer-actions .btn-secondary:hover {
      background: #e9ecef;
    }

    .existing-customers {
      margin-top: 15px;
    }

    .existing-customers h4 {
      margin-bottom: 8px;
      color: #333;
      font-size: 13px;
    }

    .existing-customer-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .existing-customer-btn {
      background: #f8f9fa;
      border: 1px solid #ddd;
      border-radius: 4px;
      padding: 6px 10px;
      font-size: 11px;
      cursor: pointer;
      color: #555;
    }

    .existing-customer-btn:hover {
      background: #e9ecef;
      border-color: #adb5bd;
    }

    /* Filtered Customer Selection Styles */
    .filtered-customer-selection {
      margin: 20px 0;
      padding: 15px;
      background: #f8f9fa;
      border: 1px solid #dee2e6;
      border-radius: 8px;
    }

    .filtered-customer-selection h4 {
      color: #495057;
      margin-bottom: 15px;
      font-size: 16px;
      font-weight: 600;
    }

    .filtered-customer-selection h5 {
      color: #6c757d;
      margin-bottom: 10px;
      font-size: 14px;
      font-weight: 500;
    }

    .report-type-selection {
      margin-bottom: 20px;
      padding-bottom: 15px;
      border-bottom: 1px solid #dee2e6;
    }

    .customer-selection-section {
      margin-top: 15px;
    }

    .customer-requirement, .report-requirement {
      color: #dc3545;
      font-size: 12px;
      margin-top: 8px;
      font-style: italic;
    }

    .requirements {
      margin-top: 10px;
    }

    .process-filtered-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    /* Modal Styles */
    .modal {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .modal-content {
      background: white;
      border-radius: 8px;
      width: 90%;
      max-width: 500px;
      max-height: 90vh;
      overflow-y: auto;
    }

    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 20px;
      border-bottom: 1px solid #eee;
    }

    .modal-header h2 {
      margin: 0;
      color: #333;
      font-size: 18px;
    }

    .close {
      font-size: 24px;
      cursor: pointer;
      color: #999;
    }

    .close:hover {
      color: #333;
    }

    .modal-body {
      padding: 20px;
    }

    .form-group {
      margin-bottom: 15px;
    }

    .form-group label {
      display: block;
      margin-bottom: 5px;
      font-weight: 500;
      color: #333;
      font-size: 13px;
    }

    .form-input {
      width: 100%;
      padding: 8px 12px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 14px;
      box-sizing: border-box;
    }

    .form-input:focus {
      outline: none;
      border-color: #667eea;
      box-shadow: 0 0 0 2px rgba(102, 126, 234, 0.1);
    }

    .modal-footer {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      padding: 20px;
      border-top: 1px solid #eee;
    }

    .modal-footer .btn {
      padding: 8px 16px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
    }

    .modal-footer .btn-primary {
      background: #667eea;
      color: white;
    }

    .modal-footer .btn-primary:hover {
      background: #5a67d8;
    }

    .modal-footer .btn-secondary {
      background: #f8f9fa;
      color: #666;
      border: 1px solid #ddd;
    }

    .modal-footer .btn-secondary:hover {
      background: #e9ecef;
    }

    /* API Filtering Styles */
    .api-filtering-section {
      background: #f0f8ff;
      border: 2px solid #3498db;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 20px;
    }

    .filtering-header {
      margin-bottom: 20px;
    }

    .filtering-header h3 {
      color: #2c3e50;
      margin-bottom: 5px;
    }

    .filtering-header p {
      color: #7f8c8d;
      margin: 0;
    }

    .filtering-controls {
      background: white;
      padding: 20px;
      border-radius: 6px;
      border: 1px solid #ddd;
    }

    .filter-row {
      display: flex;
      gap: 20px;
      align-items: end;
      margin-bottom: 20px;
    }

    .filter-row:last-child {
      margin-bottom: 0;
    }

    .filter-group {
      flex: 1;
      min-width: 150px;
    }

    .filter-group label {
      display: block;
      font-weight: 500;
      margin-bottom: 5px;
      color: #2c3e50;
    }

    .filter-group select {
      width: 100%;
      padding: 8px 12px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 14px;
      background: white;
    }

    .filter-group input[type="date"] {
      width: 100%;
      padding: 8px 12px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 14px;
      background: white;
    }

    .filter-group select:disabled {
      background: #f5f5f5;
      color: #999;
    }

    .filter-actions {
      display: flex;
      gap: 10px;
      align-items: center;
    }

    .preview-btn, .clear-btn, .process-filtered-btn {
      padding: 10px 20px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
    }

    .preview-btn {
      background: #3498db;
      color: white;
    }

    .preview-btn:hover:not(:disabled) {
      background: #2980b9;
    }

    .preview-btn:disabled {
      background: #bdc3c7;
      cursor: not-allowed;
    }

    .clear-btn {
      background: #95a5a6;
      color: white;
    }

    .clear-btn:hover {
      background: #7f8c8d;
    }

    .process-filtered-btn {
      background: #27ae60;
      color: white;
    }

    .process-filtered-btn:hover:not(:disabled) {
      background: #229954;
    }

    .process-filtered-btn:disabled {
      background: #bdc3c7;
      cursor: not-allowed;
    }

    .filter-validation {
      margin-top: 15px;
      padding: 15px;
      border-radius: 4px;
    }

    .validation-errors {
      background: #fee;
      border: 1px solid #f5c6cb;
      border-radius: 4px;
      padding: 10px;
      margin-bottom: 10px;
    }

    .validation-errors h4 {
      color: #721c24;
      margin: 0 0 10px 0;
      font-size: 14px;
    }

    .validation-errors ul {
      margin: 0;
      padding-left: 20px;
    }

    .validation-errors li {
      color: #721c24;
      font-size: 13px;
    }

    .validation-warnings {
      background: #fff3cd;
      border: 1px solid #ffeaa7;
      border-radius: 4px;
      padding: 10px;
    }

    .validation-warnings h4 {
      color: #856404;
      margin: 0 0 10px 0;
      font-size: 14px;
    }

    .validation-warnings ul {
      margin: 0;
      padding-left: 20px;
    }

    .validation-warnings li {
      color: #856404;
      font-size: 13px;
    }

    .project-preview {
      margin-top: 20px;
      padding: 20px;
      background: white;
      border: 1px solid #ddd;
      border-radius: 6px;
    }

    .project-preview h4 {
      color: #2c3e50;
      margin-bottom: 15px;
    }

    .preview-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 15px;
      margin-bottom: 20px;
    }

    .preview-item {
      background: #f8f9fa;
      border: 1px solid #e9ecef;
      border-radius: 4px;
      padding: 15px;
    }

    .preview-id {
      font-weight: bold;
      color: #2c3e50;
      margin-bottom: 5px;
    }

    .preview-title {
      font-size: 14px;
      color: #2c3e50;
      margin-bottom: 8px;
      line-height: 1.4;
    }

    .preview-details {
      font-size: 12px;
      color: #7f8c8d;
    }

    .preview-actions {
      text-align: center;
      padding-top: 15px;
      border-top: 1px solid #eee;
    }
  `]
})
export class DocumentsBrowserComponent implements OnInit {
  activeTab: 'aws' | 'local' = 'aws';

  // AWS S3 properties
  awsFolders: AWSFolder[] = [];
  selectedAWSFolders = new Set<string>();
  selectedAWSFolder: string = '';
  awsProjects: AWSProject[] = [];
  filteredAWSProjects: AWSProject[] = [];
  selectedAWSProjects = new Set<string>();
  awsSearchTerm = '';
  awsSortBy = 'projectId';
  awsStats: any = null;
  awsPagination: any = null;
  loadingAWS = false;
  showingFolders = true;
  Array = Array; // Make Array available in template

  // Local properties
  availableDrives: Drive[] = [];
  selectedDrive = '';
  currentLocalPath = '';
  localFileItems: FileSystemItem[] = [];
  localProjects: LocalProject[] = [];
  selectedLocalProjects = new Set<string>();
  showFolderBrowser = false;
  loadingLocal = false;

  // Processing properties
  reportTypes = [
    { name: 'Acoustic', value: 'acoustic', selected: false },
    { name: 'Transport', value: 'transport', selected: false },
    { name: 'Ecological', value: 'ecological', selected: false },
    { name: 'Flood Risk', value: 'flood', selected: false },
    { name: 'Heritage', value: 'heritage', selected: false },
    { name: 'Arboricultural', value: 'arboricultural', selected: false }
  ];

  // Customer management
  selectedCustomers: Array<{name: string, email: string}> = [];
  showAddCustomerModal = false;
  newCustomer = { name: '', email: '' };
  existingCustomers: Array<{name: string, email: string}> = [];
  customerEmails = ''; // Keep for backward compatibility during transition

  // API Filtering properties
  showApiFiltering = false;
  dropdownData: DropdownData | null = null;
  selectedFilters: FilteringParams = {};
  previewedProjects: ProjectPreview[] = [];
  filterValidation: any = null;
  loadingFilters = false;
  loadingPreview = false;
  processingWithFilters = false;

  processingMode: 'immediate' | 'scheduled' = 'immediate';
  scheduleTime = '';

  Math = Math;

  constructor(
    private http: HttpClient,
    private toastr: ToastrService,
    private customerService: CustomerService,
    private apiFilteringService: ApiFilteringService
  ) {}

  ngOnInit() {
    this.loadAvailableDrives();
    this.loadAWSStats();
    this.loadAWSFolders();
    this.loadExistingCustomers();
    this.loadDropdownData();
  }

  setActiveTab(tab: 'aws' | 'local') {
    this.activeTab = tab;
    if (tab === 'local' && this.availableDrives.length === 0) {
      this.loadAvailableDrives();
    }
  }

  // API Filtering Methods
  toggleApiFiltering() {
    this.showApiFiltering = !this.showApiFiltering;
    if (this.showApiFiltering && !this.dropdownData) {
      this.loadDropdownData();
    }
  }

  loadDropdownData() {
    this.loadingFilters = true;
    this.apiFilteringService.getDropdownData().subscribe({
      next: (data) => {
        this.dropdownData = data;
        this.loadingFilters = false;
      },
      error: (error) => {
        console.error('Error loading dropdown data:', error);
        this.toastr.error('Failed to load filter options');
        this.loadingFilters = false;
      }
    });
  }

  onCategoryChange() {
    // Clear subcategory when category changes
    this.selectedFilters.subcategory = undefined;
  }

  onDateFilterChange() {
    // Clear custom date range when switching away from custom range
    if (this.selectedFilters.apion !== '8') {
      this.selectedFilters.min_apion = undefined;
      this.selectedFilters.max_apion = undefined;
    }
  }

  getSubcategoriesForCategory(categoryId: number | undefined): Array<{ id: number; name: string }> {
    if (!categoryId || !this.dropdownData) return [];
    const category = this.dropdownData.categories.find(cat => cat.id === categoryId);
    return category ? category.subcategories : [];
  }

  previewFilteredProjects() {
    if (!this.hasValidFilters()) {
      this.toastr.warning('Please select at least one filter option');
      return;
    }

    this.loadingPreview = true;
    this.previewedProjects = [];

    // Clean the filters (remove empty strings and convert to proper types)
    const cleanedFilters = this.cleanFilterParams(this.selectedFilters);

    // Debug logging
    console.log('🔍 Raw selectedFilters:', this.selectedFilters);
    console.log('🔍 Cleaned filters being sent:', cleanedFilters);

    // First validate parameters
    this.apiFilteringService.validateParams(cleanedFilters).subscribe({
      next: (validation) => {
        this.filterValidation = validation;
        if (validation.valid) {
          // Proceed with preview
          this.apiFilteringService.previewProjects(cleanedFilters).subscribe({
            next: (response) => {
              this.previewedProjects = response.projects || [];
              this.loadingPreview = false;
              this.toastr.success(`Found ${this.previewedProjects.length} projects matching filters`);
            },
            error: (error) => {
              console.error('Error previewing projects:', error);
              this.toastr.error('Failed to preview projects');
              this.loadingPreview = false;
            }
          });
        } else {
          this.loadingPreview = false;
          this.toastr.error('Filter validation failed');
        }
      },
      error: (error) => {
        console.error('Error validating filters:', error);
        this.toastr.error('Failed to validate filters');
        this.loadingPreview = false;
      }
    });
  }

  cleanFilterParams(filters: any): FilteringParams {
    const cleaned: FilteringParams = {};

    // Only include non-empty values and convert strings to numbers for numeric fields
    if (filters.category && filters.category !== '' && filters.category !== null) {
      cleaned.category = typeof filters.category === 'string' ? parseInt(filters.category) : filters.category;
    }
    if (filters.subcategory && filters.subcategory !== '' && filters.subcategory !== null) {
      cleaned.subcategory = typeof filters.subcategory === 'string' ? parseInt(filters.subcategory) : filters.subcategory;
    }
    if (filters.county && filters.county !== '' && filters.county !== null) {
      cleaned.county = typeof filters.county === 'string' ? parseInt(filters.county) : filters.county;
    }
    if (filters.stage && filters.stage !== '' && filters.stage !== null) {
      cleaned.stage = typeof filters.stage === 'string' ? parseInt(filters.stage) : filters.stage;
    }
    if (filters.type && filters.type !== '' && filters.type !== null) {
      cleaned.type = typeof filters.type === 'string' ? parseInt(filters.type) : filters.type;
    }
    if (filters.apion && filters.apion !== '' && filters.apion !== null) {
      cleaned.apion = filters.apion;
    }
    if (filters.min_apion && filters.min_apion !== '' && filters.min_apion !== null) {
      cleaned.min_apion = filters.min_apion;
    }
    if (filters.max_apion && filters.max_apion !== '' && filters.max_apion !== null) {
      cleaned.max_apion = filters.max_apion;
    }

    return cleaned;
  }

  clearFilters() {
    this.selectedFilters = {};
    this.previewedProjects = [];
    this.filterValidation = null;
  }

  hasValidFilters(): boolean {
    return !!(this.selectedFilters.category ||
              this.selectedFilters.county ||
              this.selectedFilters.stage ||
              this.selectedFilters.type);
  }

  processFIWithApiFilters() {
    if (this.selectedCustomers.length === 0) {
      this.toastr.error('Please select at least one customer');
      return;
    }

    if (!this.hasValidFilters()) {
      this.toastr.error('Please configure filters and preview projects first');
      return;
    }

    const selectedReportTypes = this.reportTypes
      .filter(type => type.selected)
      .map(type => type.value);

    if (selectedReportTypes.length === 0) {
      this.toastr.error('Please select at least one report type');
      return;
    }

    this.processingWithFilters = true;

    // Clean filters just like in previewFilteredProjects
    const cleanedFilters = this.cleanFilterParams(this.selectedFilters);

    console.log('🔍 Raw selectedFilters:', this.selectedFilters);
    console.log('🔍 Cleaned filters:', cleanedFilters);

    const processingParams = {
      filters: cleanedFilters,
      customers: this.selectedCustomers,
      reportTypes: selectedReportTypes,
      processingMode: this.processingMode,
      scheduleTime: this.processingMode === 'scheduled' ? this.scheduleTime : undefined
    };

    this.apiFilteringService.processFIWithFilters(processingParams).subscribe({
      next: (response) => {
        this.processingWithFilters = false;
        if (response.success) {
          this.toastr.success(`Successfully processed ${response.processed} projects`);
          // Reset state after successful processing
          this.clearFilters();
          this.showApiFiltering = false;
        } else {
          this.toastr.error(`Processing failed: ${response.message}`);
        }
      },
      error: (error) => {
        console.error('Error processing with filters:', error);
        this.toastr.error('Failed to process projects with filters');
        this.processingWithFilters = false;
      }
    });
  }

  // AWS Methods
  async loadAWSStats() {
    try {
      const response = await this.http.get<any>('http://localhost:3000/api/documents-browser/aws/stats').toPromise();
      this.awsStats = response.data;
    } catch (error) {
      console.error('Error loading AWS stats:', error);
    }
  }

  async loadAWSFolders() {
    this.loadingAWS = true;
    try {
      const response = await this.http.get<any>('http://localhost:3000/api/documents-browser/aws/folders').toPromise();
      this.awsFolders = response.data.folders;
      this.showingFolders = true;
    } catch (error) {
      console.error('Error loading AWS folders:', error);
      this.toastr.error('Failed to load AWS folders');
    } finally {
      this.loadingAWS = false;
    }
  }

  async loadProjectsInFolder(folderName: string, offset = 0, limit = 20) {
    this.loadingAWS = true;
    this.selectedAWSFolder = folderName;
    try {
      const response = await this.http.get<any>(
        `http://localhost:3000/api/documents-browser/aws/folders/${folderName}/projects?offset=${offset}&limit=${limit}`
      ).toPromise();

      this.awsProjects = response.data.projects;
      this.awsPagination = response.data.pagination;
      this.showingFolders = false;
      this.filterAWSProjects();
    } catch (error) {
      console.error('Error loading projects in folder:', error);
      this.toastr.error('Failed to load projects in folder');
    } finally {
      this.loadingAWS = false;
    }
  }

  backToFolders() {
    this.showingFolders = true;
    this.selectedAWSFolder = '';
    this.awsProjects = [];
    this.filteredAWSProjects = [];
    this.awsPagination = null;
  }

  toggleFolderSelection(folderName: string) {
    if (this.selectedAWSFolders.has(folderName)) {
      this.selectedAWSFolders.delete(folderName);
    } else {
      this.selectedAWSFolders.add(folderName);
    }
  }

  canProcessFolders(): boolean {
    return this.reportTypes.some(type => type.selected);
  }

  hasSelectedReportTypes(): boolean {
    return this.reportTypes.some(type => type.selected);
  }

  getSelectedReportTypesCount(): number {
    return this.reportTypes.filter(type => type.selected).length;
  }

  clearFolderSelections() {
    this.selectedAWSFolders.clear();
    this.reportTypes.forEach(type => type.selected = false);
    this.customerEmails = '';
  }

  async processSingleFolder(folderName: string) {
    const selectedReportTypes = this.reportTypes
      .filter(type => type.selected)
      .map(type => type.value);

    if (selectedReportTypes.length === 0) {
      this.toastr.warning('Please select at least one report type');
      return;
    }

    // Use selectedCustomers if available, otherwise fall back to customerEmails string
    let customers: Array<{name: string, email: string}> = [];
    if (this.selectedCustomers.length > 0) {
      customers = this.selectedCustomers;
    } else if (this.customerEmails) {
      // Legacy support for old customerEmails string
      const emails = this.customerEmails
        .split(',')
        .map(email => email.trim())
        .filter(email => email);

      customers = emails.map(email => ({
        email,
        name: email.split('@')[0] // Default name from email
      }));
    }

    // Create customers in database if needed
    if (customers.length > 0) {
      await this.createCustomersFromObjects(customers);
    }

    try {
      this.toastr.info(`Starting FI processing for entire folder: ${folderName}...`);

      const response = await this.http.post<any>('http://localhost:3000/api/documents-browser/aws/process-folder', {
        folderNames: [folderName],
        reportTypes: selectedReportTypes,
        customers: customers // Send customer objects instead of just emails
      }).toPromise();

      const summary = response.data.summary;

      if (summary.matchesFound > 0) {
        this.toastr.success(
          `FI processing complete! Found matches in ${summary.matchesFound} projects out of ${summary.totalProjects} processed from folder ${folderName}.`
        );
      } else if (summary.processed > 0) {
        this.toastr.info(
          `FI processing complete! No matches found in ${summary.processed} projects from folder ${folderName}.`
        );
      } else {
        this.toastr.warning('FI processing completed with errors. Check console for details.');
      }

      console.log('Folder FI Processing Results:', response.data);

    } catch (error) {
      console.error('Error processing folder:', error);
      this.toastr.error(`Failed to process folder ${folderName}`);
    }
  }

  async processSelectedFolders() {
    const selectedReportTypes = this.reportTypes
      .filter(type => type.selected)
      .map(type => type.value);

    // Use selectedCustomers if available, otherwise fall back to customerEmails string
    let customers: Array<{name: string, email: string}> = [];
    if (this.selectedCustomers.length > 0) {
      customers = this.selectedCustomers;
    } else if (this.customerEmails) {
      // Legacy support for old customerEmails string
      const emails = this.customerEmails
        .split(',')
        .map(email => email.trim())
        .filter(email => email);

      customers = emails.map(email => ({
        email,
        name: email.split('@')[0] // Default name from email
      }));
    }

    // Create customers in database if needed
    if (customers.length > 0) {
      await this.createCustomersFromObjects(customers);
    }

    const folderNames = Array.from(this.selectedAWSFolders);

    try {
      this.toastr.info(`Starting FI processing for ${folderNames.length} folders...`);

      const response = await this.http.post<any>('http://localhost:3000/api/documents-browser/aws/process-folder', {
        folderNames,
        reportTypes: selectedReportTypes,
        customers: customers // Send customer objects instead of just emails
      }).toPromise();

      const summary = response.data.summary;

      if (summary.matchesFound > 0) {
        this.toastr.success(
          `FI processing complete! Found matches in ${summary.matchesFound} projects out of ${summary.totalProjects} processed from ${summary.totalFolders} folders.`
        );
      } else if (summary.processed > 0) {
        this.toastr.info(
          `FI processing complete! No matches found in ${summary.processed} projects from ${summary.totalFolders} folders.`
        );
      } else {
        this.toastr.warning('FI processing completed with errors. Check console for details.');
      }

      console.log('Multi-Folder FI Processing Results:', response.data);
      this.clearFolderSelections();

    } catch (error) {
      console.error('Error processing folders:', error);
      this.toastr.error('Failed to process selected folders');
    }
  }

  async loadAWSProjects(offset = 0, limit = 20) {
    this.loadingAWS = true;
    try {
      const response = await this.http.get<any>(`http://localhost:3000/api/documents-browser/aws/projects?offset=${offset}&limit=${limit}`).toPromise();
      this.awsProjects = response.data.projects;
      this.awsPagination = response.data.pagination;
      this.filterAWSProjects();
    } catch (error) {
      console.error('Error loading AWS projects:', error);
      this.toastr.error('Failed to load AWS projects');
    } finally {
      this.loadingAWS = false;
    }
  }

  refreshAWSProjects() {
    if (this.showingFolders) {
      this.loadAWSFolders();
    } else {
      this.loadProjectsInFolder(this.selectedAWSFolder, this.awsPagination?.offset || 0);
    }
  }

  filterAWSProjects() {
    let filtered = [...this.awsProjects];

    if (this.awsSearchTerm) {
      const term = this.awsSearchTerm.toLowerCase();
      filtered = filtered.filter(project =>
        project.projectId.toLowerCase().includes(term) ||
        project.displayName.toLowerCase().includes(term)
      );
    }

    this.sortAWSProjects(filtered);
  }

  sortAWSProjects(projects = this.filteredAWSProjects) {
    projects.sort((a, b) => {
      switch (this.awsSortBy) {
        case 'title':
          return a.displayName.localeCompare(b.displayName);
        case 'pdfCount':
          return b.pdfCount - a.pdfCount;
        default:
          return a.projectId.localeCompare(b.projectId);
      }
    });
    this.filteredAWSProjects = projects;
  }

  toggleAWSProjectSelection(project: AWSProject) {
    if (this.selectedAWSProjects.has(project.projectId)) {
      this.selectedAWSProjects.delete(project.projectId);
    } else {
      this.selectedAWSProjects.add(project.projectId);
    }
  }

  // Local Methods
  async loadAvailableDrives() {
    try {
      const response = await this.http.get<any>('http://localhost:3000/api/documents-browser/local/drives').toPromise();
      this.availableDrives = response.data.drives;
    } catch (error) {
      console.error('Error loading drives:', error);
      this.toastr.error('Failed to load available drives');
    }
  }

  async browseLocalPath(path: string) {
    if (!path) return;

    this.loadingLocal = true;
    try {
      const response = await this.http.get<any>(`http://localhost:3000/api/documents-browser/local/browse?path=${encodeURIComponent(path)}`).toPromise();
      this.currentLocalPath = response.data.currentPath;
      this.localFileItems = response.data.items;
    } catch (error) {
      console.error('Error browsing path:', error);
      this.toastr.error('Failed to browse directory');
    } finally {
      this.loadingLocal = false;
    }
  }

  async scanForProjects() {
    if (!this.currentLocalPath) {
      this.toastr.warning('Please select a directory first');
      return;
    }

    this.loadingLocal = true;
    try {
      const response = await this.http.post<any>('http://localhost:3000/api/documents-browser/local/scan-projects', {
        rootPath: this.currentLocalPath
      }).toPromise();

      this.localProjects = response.data.projects;
      if (this.localProjects.length === 0) {
        this.toastr.info('No project folders found in this directory');
      } else {
        this.toastr.success(`Found ${this.localProjects.length} project folders`);
      }
    } catch (error) {
      console.error('Error scanning for projects:', error);
      this.toastr.error('Failed to scan for projects');
    } finally {
      this.loadingLocal = false;
    }
  }

  toggleLocalProjectSelection(project: LocalProject) {
    if (this.selectedLocalProjects.has(project.projectId)) {
      this.selectedLocalProjects.delete(project.projectId);
    } else {
      this.selectedLocalProjects.add(project.projectId);
    }
  }

  // Local Folder Processing Methods
  canProcessLocalFolder(): boolean {
    return this.reportTypes.some(type => type.selected) && this.localProjects.length > 0;
  }

  async processCurrentLocalFolder() {
    const selectedReportTypes = this.reportTypes
      .filter(type => type.selected)
      .map(type => type.value);

    if (selectedReportTypes.length === 0) {
      this.toastr.warning('Please select at least one report type');
      return;
    }

    // Use selectedCustomers if available, otherwise fall back to customerEmails string
    let customers: Array<{name: string, email: string}> = [];
    if (this.selectedCustomers.length > 0) {
      customers = this.selectedCustomers;
    } else if (this.customerEmails) {
      // Legacy support for old customerEmails string
      const emails = this.customerEmails
        .split(',')
        .map(email => email.trim())
        .filter(email => email);

      customers = emails.map(email => ({
        email,
        name: email.split('@')[0] // Default name from email
      }));
    }

    // Create customers in database if needed
    if (customers.length > 0) {
      await this.createCustomersFromObjects(customers);
    }

    try {
      this.toastr.info(`Starting FI processing for entire folder: ${this.currentLocalPath}...`);

      const response = await this.http.post<any>('http://localhost:3000/api/documents-browser/local/process-folder', {
        folderPaths: [this.currentLocalPath],
        reportTypes: selectedReportTypes,
        customers: customers // Send customer objects instead of just emails
      }).toPromise();

      const summary = response.data.summary;

      if (summary.matchesFound > 0) {
        this.toastr.success(
          `FI processing complete! Found matches in ${summary.matchesFound} projects out of ${summary.totalProjects} processed from local folder.`
        );
      } else if (summary.processed > 0) {
        this.toastr.info(
          `FI processing complete! No matches found in ${summary.processed} projects processed from local folder.`
        );
      } else {
        this.toastr.warning('FI processing completed with errors. Check console for details.');
      }

      console.log('Local FI Processing Results:', response.data);
      this.clearLocalSelections();

    } catch (error) {
      console.error('Error starting local FI processing:', error);
      this.toastr.error('Failed to start local FI processing');
    }
  }

  clearLocalSelections() {
    this.selectedLocalProjects.clear();
    this.reportTypes.forEach(type => type.selected = false);
    this.customerEmails = '';
  }

  // Processing Methods
  hasSelections(): boolean {
    return this.selectedAWSProjects.size > 0 || this.selectedLocalProjects.size > 0;
  }

  canStartProcessing(): boolean {
    const hasProjects = this.hasSelections();
    const hasReportTypes = this.reportTypes.some(type => type.selected);
    const hasValidSchedule = this.processingMode === 'immediate' ||
      (this.processingMode === 'scheduled' && !!this.scheduleTime);

    return hasProjects && hasReportTypes && hasValidSchedule;
  }

  async startFIProcessing() {
    const selectedReportTypes = this.reportTypes
      .filter(type => type.selected)
      .map(type => type.value);

    // Use selectedCustomers if available, otherwise fall back to customerEmails string
    let customers: Array<{name: string, email: string}> = [];
    if (this.selectedCustomers.length > 0) {
      customers = this.selectedCustomers;
    } else if (this.customerEmails) {
      // Legacy support for old customerEmails string
      const emails = this.customerEmails
        .split(',')
        .map(email => email.trim())
        .filter(email => email);

      customers = emails.map(email => ({
        email,
        name: email.split('@')[0] // Default name from email
      }));
    }

    // Create customers in database if needed
    if (customers.length > 0) {
      await this.createCustomersFromObjects(customers);
    }

    const totalProjects = this.selectedAWSProjects.size + this.selectedLocalProjects.size;

    try {
      this.toastr.info(`Starting FI processing for ${totalProjects} projects...`);

      // Process AWS projects if any are selected
      if (this.selectedAWSProjects.size > 0) {
        const awsProjectIds = Array.from(this.selectedAWSProjects);

        const awsResponse = await this.http.post<any>('http://localhost:3000/api/documents-browser/aws/process-fi', {
          projectIds: awsProjectIds,
          reportTypes: selectedReportTypes,
          customers: customers, // Send customer objects instead of just emails
          scheduleTime: this.processingMode === 'scheduled' ? this.scheduleTime : null
        }).toPromise();

        console.log('AWS FI Processing Results:', awsResponse.data);
      }

      // Process local projects if any are selected
      if (this.selectedLocalProjects.size > 0) {
        const localProjectPaths = this.localProjects
          .filter(project => this.selectedLocalProjects.has(project.projectId))
          .map(project => project.path);

        const localResponse = await this.http.post<any>('http://localhost:3000/api/documents-browser/local/process-fi', {
          projectPaths: localProjectPaths,
          reportTypes: selectedReportTypes,
          customers: customers, // Send customer objects instead of just emails
          scheduleTime: this.processingMode === 'scheduled' ? this.scheduleTime : null
        }).toPromise();

        console.log('Local FI Processing Results:', localResponse.data);
      }

      // Show combined success message
      this.toastr.success(`FI processing initiated for ${totalProjects} projects. Check console for detailed results.`);
      this.clearSelections();

    } catch (error) {
      console.error('Error starting FI processing:', error);
      this.toastr.error('Failed to start FI processing');
    }
  }

  clearSelections() {
    this.selectedAWSProjects.clear();
    this.selectedLocalProjects.clear();
    this.reportTypes.forEach(type => type.selected = false);
    this.customerEmails = '';
    this.scheduleTime = '';
  }

  // Create customers immediately when emails are provided
  private async createCustomersFromEmails(emails: string[]): Promise<void> {
    try {
      for (const email of emails) {
        if (email && this.isValidEmail(email)) {
          await this.customerService.createCustomer({
            email: email,
            name: email.split('@')[0] // Use email prefix as default name
          });
        }
      }
    } catch (error) {
      console.warn('Error creating customers:', error);
      // Don't block FI processing if customer creation fails
    }
  }

  // Create customers from customer objects with names and emails
  private async createCustomersFromObjects(customers: Array<{name: string, email: string}>): Promise<void> {
    try {
      for (const customer of customers) {
        if (customer.email && this.isValidEmail(customer.email)) {
          await this.customerService.createCustomer({
            email: customer.email,
            name: customer.name || customer.email.split('@')[0] // Use provided name or email prefix as fallback
          });
        }
      }
    } catch (error) {
      console.warn('Error creating customers:', error);
      // Don't block FI processing if customer creation fails
    }
  }

  private isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  // Customer Management Methods
  async loadExistingCustomers() {
    try {
      this.customerService.getCustomers({ isActive: true, limit: 100 }).subscribe({
        next: (response: any) => {
          if (response.customers) {
            this.existingCustomers = response.customers
              .filter((customer: any) => customer.isActive)
              .map((customer: any) => ({
                name: customer.name,
                email: customer.email
              }));
          }
        },
        error: (error: any) => {
          console.error('Error loading existing customers:', error);
        }
      });
    } catch (error) {
      console.error('Error loading customers:', error);
    }
  }

  openAddCustomerModal() {
    this.showAddCustomerModal = true;
    this.newCustomer = { name: '', email: '' };
  }

  closeAddCustomerModal() {
    this.showAddCustomerModal = false;
    this.newCustomer = { name: '', email: '' };
  }

  addNewCustomer() {
    if (!this.newCustomer.name.trim() || !this.newCustomer.email.trim()) {
      this.toastr.error('Please enter both name and email');
      return;
    }

    if (!this.isValidEmail(this.newCustomer.email)) {
      this.toastr.error('Please enter a valid email address');
      return;
    }

    // Check if customer already exists in selected list
    if (this.selectedCustomers.some(c => c.email.toLowerCase() === this.newCustomer.email.toLowerCase())) {
      this.toastr.warning('Customer already added to the list');
      return;
    }

    // Add to selected customers
    this.selectedCustomers.push({
      name: this.newCustomer.name.trim(),
      email: this.newCustomer.email.trim()
    });

    this.toastr.success(`Added ${this.newCustomer.name} to customer list`);
    this.closeAddCustomerModal();
    this.updateCustomerEmailsString();
  }

  selectExistingCustomer(customer: {name: string, email: string}) {
    if (this.selectedCustomers.some(c => c.email.toLowerCase() === customer.email.toLowerCase())) {
      this.toastr.warning('Customer already added to the list');
      return;
    }

    this.selectedCustomers.push(customer);
    this.toastr.success(`Added ${customer.name} to customer list`);
    this.updateCustomerEmailsString();
  }

  removeSelectedCustomer(index: number) {
    const customer = this.selectedCustomers[index];
    this.selectedCustomers.splice(index, 1);
    this.toastr.info(`Removed ${customer.name} from customer list`);
    this.updateCustomerEmailsString();
  }

  private updateCustomerEmailsString() {
    // Update the customerEmails string for backward compatibility
    this.customerEmails = this.selectedCustomers.map(c => c.email).join(', ');
  }

  clearAllCustomers() {
    this.selectedCustomers = [];
    this.customerEmails = '';
    this.toastr.info('Cleared all customers');
  }

  // Utility Methods
  formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}