import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { CustomerService, Customer, CustomerHistory, CustomerRequest } from '../../../services/customer.service';
import { ApiFilteringService, DropdownData } from '../../../services/api-filtering.service';
import { ToastrService } from 'ngx-toastr';
import { environment } from '../../../../environments/environment';
import { IconComponent } from '../../shared/icon/icon.component';

@Component({
  selector: 'app-customer-list',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, IconComponent],
  styleUrls: ['./customer-list.component.css'],
  template: `
    <div class="customers-container">
      <div class="page-header">
        <h1>Customer Management</h1>
        <div class="header-actions">
          <button class="btn btn-primary" (click)="openAddCustomerModal()">
            <app-icon name="plus" [size]="15"></app-icon>
            Add Customer
          </button>
        </div>
      </div>

      <div class="search-filters">
        <div class="search-box">
          <app-icon name="search" [size]="16"></app-icon>
          <input
            type="text"
            placeholder="Search by name, email, or company…"
            [(ngModel)]="searchQuery"
            (input)="onSearchChange()"
            class="search-input"
          >
        </div>
        <select [(ngModel)]="selectedReportType" (change)="onFilterChange()" class="filter-select">
          <option value="">All Report Types</option>
          <option value="acoustic">Acoustic</option>
          <option value="transport">Transport</option>
          <option value="ecological">Ecological</option>
          <option value="flood">Flood</option>
          <option value="heritage">Heritage</option>
          <option value="arboricultural">Arboricultural</option>
          <option value="waste">Waste</option>
          <option value="lighting">Lighting</option>
        </select>
        <select [(ngModel)]="selectedStatus" (change)="onFilterChange()" class="filter-select">
          <option value="">All Statuses</option>
          <option value="true">Active Only</option>
          <option value="false">Inactive Only</option>
        </select>
      </div>

      <div class="customers-section">
        <div class="loading" *ngIf="isLoading">
          <div class="spinner large"></div>
          <p>Loading customers...</p>
        </div>

        <div class="customers-table-wrap" *ngIf="!isLoading && customers.length > 0">
          <div class="table-toolbar">
            <span class="result-count">{{ customers.length }} customer{{ customers.length === 1 ? '' : 's' }}</span>
            <div class="page-size">
              <label>Rows per page</label>
              <select [(ngModel)]="pageSize" (ngModelChange)="onPageSizeChange()" class="filter-select sm">
                <option [ngValue]="25">25</option>
                <option [ngValue]="50">50</option>
                <option [ngValue]="100">100</option>
              </select>
            </div>
          </div>

          <div class="table-scroll">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th class="col-hide-sm">Company</th>
                  <th>Report Types</th>
                  <th class="col-hide-sm">Coverage</th>
                  <th class="num">Sent</th>
                  <th>Status</th>
                  <th class="actions-col">Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr *ngFor="let customer of pagedCustomers">
                  <td class="cell-primary">
                    <span class="cust-name">{{ customer.name }}</span>
                    <span class="cust-email">{{ customer.email }}</span>
                  </td>
                  <td class="cell-muted col-hide-sm">{{ customer.company || '—' }}</td>
                  <td>
                    <div class="chip-row" *ngIf="customer.reportTypes?.length; else noTypes">
                      <span class="chip" *ngFor="let type of customer.reportTypes!.slice(0, 2)">{{ formatReportType(type) }}</span>
                      <span class="chip more" *ngIf="customer.reportTypes!.length > 2" [title]="customer.reportTypes!.join(', ')">+{{ customer.reportTypes!.length - 2 }}</span>
                    </div>
                    <ng-template #noTypes><span class="cell-muted">—</span></ng-template>
                  </td>
                  <td class="col-hide-sm">
                    <span class="coverage-all" *ngIf="!hasFilters(customer)" title="Receives all matches (no restrictions)">
                      <app-icon name="mail" [size]="12"></app-icon> All
                    </span>
                    <span class="coverage" *ngIf="hasFilters(customer)"
                          [title]="(customer.filters?.allowedCounties?.length || 0) + ' counties, ' + (customer.filters?.allowedSectors?.length || 0) + ' sectors'">
                      {{ customer.filters?.allowedCounties?.length || 0 }}c · {{ customer.filters?.allowedSectors?.length || 0 }}s
                    </span>
                  </td>
                  <td class="num">{{ customer.emailCount || 0 }}</td>
                  <td>
                    <span class="state-pill" [class.is-active]="customer.isActive" [class.is-inactive]="!customer.isActive">
                      {{ customer.isActive ? 'Active' : 'Inactive' }}
                    </span>
                  </td>
                  <td class="actions-col">
                    <div class="row-actions">
                      <button class="icon-btn" (click)="viewCustomerReports(customer)" [disabled]="isLoading" title="View reports">
                        <app-icon name="bar-chart" [size]="15"></app-icon>
                      </button>
                      <button class="icon-btn" (click)="openEditModal(customer)" [disabled]="isUpdating" title="Edit customer">
                        <app-icon name="edit" [size]="15"></app-icon>
                      </button>
                      <button class="icon-btn" (click)="toggleCustomerStatus(customer._id)" [disabled]="isUpdating"
                              [title]="customer.isActive ? 'Deactivate' : 'Activate'">
                        <app-icon [name]="customer.isActive ? 'pause' : 'play'" [size]="15"></app-icon>
                      </button>
                      <button class="icon-btn danger" (click)="openDeleteModal(customer)" [disabled]="isUpdating" title="Delete customer">
                        <app-icon name="trash" [size]="15"></app-icon>
                      </button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="pagination" *ngIf="totalPages > 1">
            <button class="page-btn" (click)="goToPage(1)" [disabled]="currentPage === 1" title="First page">«</button>
            <button class="page-btn" (click)="prevPage()" [disabled]="currentPage === 1" title="Previous page">‹</button>
            <span class="page-info">{{ pageStart + 1 }}–{{ pageEnd }} of {{ customers.length }}</span>
            <button class="page-btn" (click)="nextPage()" [disabled]="currentPage === totalPages" title="Next page">›</button>
            <button class="page-btn" (click)="goToPage(totalPages)" [disabled]="currentPage === totalPages" title="Last page">»</button>
          </div>
        </div>

        <div class="no-customers" *ngIf="!isLoading && customers.length === 0">
          <div class="no-customers-content">
            <div class="no-customers-icon"><app-icon name="users" [size]="30"></app-icon></div>
            <h3>No Customers Found</h3>
            <p>Start by adding customers to manage FI email notifications.</p>
            <button class="btn btn-primary" (click)="openAddCustomerModal()">Add First Customer</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Customer History Modal -->
    <div class="modal" *ngIf="showHistoryModal" (click)="closeHistoryModal()">
      <div class="modal-content large" (click)="$event.stopPropagation()">
        <div class="modal-header">
          <h2><app-icon name="clipboard" [size]="18"></app-icon> FI Report History</h2>
          <span class="close" (click)="closeHistoryModal()">&times;</span>
        </div>

        <div class="modal-body" *ngIf="selectedCustomerHistory">
          <div class="customer-info-header">
            <h3>{{ selectedCustomerHistory.customer.name }}</h3>
            <p class="customer-email">{{ selectedCustomerHistory.customer.email }}</p>
            <p class="customer-company" *ngIf="selectedCustomerHistory.customer.company">
              {{ selectedCustomerHistory.customer.company }}
            </p>
            <div class="customer-summary">
              <span class="summary-stat">
                <strong>{{ selectedCustomerHistory.totalReports }}</strong> FI Reports Received
              </span>
              <span class="summary-stat">
                <strong>{{ selectedCustomerHistory.customer.emailCount }}</strong> Total Emails Sent
              </span>
            </div>
          </div>

          <div class="fi-history-list" *ngIf="selectedCustomerHistory.fiHistory.length > 0">
            <h4>Recent FI Reports</h4>
            <div class="history-item" *ngFor="let item of selectedCustomerHistory.fiHistory">
              <div class="history-header">
                <h5>{{ item.project.title }}</h5>
                <span class="report-type-badge">{{ formatReportType(item.reportType) }}</span>
              </div>
              <div class="history-details">
                <p><strong>Project ID:</strong> {{ item.projectId }}</p>
                <p><strong>Document:</strong> {{ item.fileName }}</p>
                <p><strong>Planning Authority:</strong> {{ item.project.planningAuthority }}</p>
                <p *ngIf="item.project.location"><strong>Location:</strong> {{ item.project.location }}</p>
                <p><strong>Confidence:</strong> {{ (item.confidence * 100).toFixed(0) }}%</p>
                <p><strong>Status:</strong> {{ formatStatus(item.status) }}</p>
                <p><strong>Detected:</strong> {{ formatDate(item.createdAt) }}</p>
              </div>
              <div class="notification-info" *ngIf="item.notifications.length > 0">
                <h6>Notifications Sent:</h6>
                <div class="notification-item" *ngFor="let notification of item.notifications">
                  <span class="notification-date">{{ formatDate(notification.sentAt) }}</span>
                  <span class="notification-status" [class]="'status-' + notification.status">
                    {{ formatStatus(notification.status) }}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div class="no-history" *ngIf="selectedCustomerHistory.fiHistory.length === 0">
            <p>No FI reports found for this customer.</p>
          </div>
        </div>

        <div class="modal-loading" *ngIf="historyLoading">
          <div class="spinner"></div>
          <p>Loading customer history...</p>
        </div>
      </div>
    </div>

    <!-- Quick Select Success Modal -->
    <div class="modal" *ngIf="showQuickSelectModal" (click)="closeQuickSelectModal()">
      <div class="modal-content" (click)="$event.stopPropagation()">
        <div class="modal-header">
          <h2><app-icon name="mail" [size]="18"></app-icon> Customer Selected</h2>
          <span class="close" (click)="closeQuickSelectModal()">&times;</span>
        </div>
        <div class="modal-body">
          <div class="success-message">
            <div class="success-icon"><app-icon name="check-circle" [size]="40"></app-icon></div>
            <h3>Customer email copied to clipboard!</h3>
            <p>Email: <strong>{{ quickSelectedCustomer?.email }}</strong></p>
            <p>You can now paste this email when creating a new FI report.</p>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-primary" (click)="closeQuickSelectModal()">Got it</button>
        </div>
      </div>
    </div>

    <!-- Add Customer Modal -->
    <div class="modal" *ngIf="showAddCustomer" (click)="closeAddCustomerModal()">
      <div class="modal-content" (click)="$event.stopPropagation()">
        <div class="modal-header">
          <h2>Add New Customer</h2>
          <button class="close-btn" (click)="closeAddCustomerModal()">×</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label for="new-name">Name *</label>
            <input
              id="new-name"
              type="text"
              class="form-control"
              [(ngModel)]="newCustomer.name"
              placeholder="Enter customer name"
              [disabled]="isCreatingCustomer"
            >
          </div>

          <div class="form-group">
            <label for="new-email">Email *</label>
            <input
              id="new-email"
              type="email"
              class="form-control"
              [(ngModel)]="newCustomer.email"
              placeholder="Enter email address"
              [disabled]="isCreatingCustomer"
            >
          </div>

          <div class="form-group">
            <label for="new-company">Company</label>
            <input
              id="new-company"
              type="text"
              class="form-control"
              [(ngModel)]="newCustomer.company"
              placeholder="Enter company name (optional)"
              [disabled]="isCreatingCustomer"
            >
          </div>

          <div class="form-group">
            <label for="new-phone">Phone</label>
            <input
              id="new-phone"
              type="text"
              class="form-control"
              [(ngModel)]="newCustomer.phone"
              placeholder="Enter phone number (optional)"
              [disabled]="isCreatingCustomer"
            >
          </div>

          <div class="form-group">
            <label for="new-project-id">Project ID</label>
            <input
              id="new-project-id"
              type="text"
              class="form-control"
              [(ngModel)]="newCustomer.projectId"
              placeholder="Enter project ID (optional)"
              [disabled]="isCreatingCustomer"
            >
          </div>

          <div class="form-group">
            <label>Report Types *</label>
            <p class="filter-help">Select at least one report type this customer should receive.</p>
            <div class="filter-chips">
              <button
                *ngFor="let reportType of availableReportTypes"
                type="button"
                class="filter-chip"
                [class.selected]="isNewCustomerReportTypeSelected(reportType.value)"
                (click)="toggleNewCustomerReportType(reportType.value)"
                [disabled]="isCreatingCustomer"
              >
                {{ reportType.label }}
              </button>
            </div>
          </div>

          <p class="filter-help">County and sector filters can be configured after creation from the Edit dialog.</p>
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary" (click)="closeAddCustomerModal()" [disabled]="isCreatingCustomer">
            Cancel
          </button>
          <button class="btn btn-primary" (click)="createCustomer()" [disabled]="!canCreateCustomer() || isCreatingCustomer">
            <span *ngIf="isCreatingCustomer">Creating...</span>
            <span *ngIf="!isCreatingCustomer">Create Customer</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Reports Modal -->
    <div class="modal" *ngIf="showReportsModal" (click)="closeReportsModal()">
      <div class="modal-content modal-lg" (click)="$event.stopPropagation()">
        <div class="modal-header">
          <h2><app-icon name="bar-chart" [size]="18"></app-icon> Customer Reports</h2>
          <div class="modal-customer-info" *ngIf="selectedCustomerForReports">
            <span class="customer-name">{{ selectedCustomerForReports.name }}</span>
            <span class="customer-email">{{ selectedCustomerForReports.email }}</span>
          </div>
          <button class="close-btn" (click)="closeReportsModal()">×</button>
        </div>
        <div class="modal-body">
          <div *ngIf="reportsLoading" class="loading-spinner">
            <span><app-icon name="loader" [size]="14" [spin]="true"></app-icon> Loading reports…</span>
          </div>

          <div *ngIf="!reportsLoading && customerReports.length === 0" class="empty-state">
            <span><app-icon name="file-text" [size]="14"></app-icon> No reports found for this customer</span>
          </div>

          <div *ngIf="!reportsLoading && customerReports.length > 0" class="reports-list">
            <div class="reports-summary">
              <h3>Reports Overview ({{ customerReports.length }} total)</h3>
            </div>

            <div class="report-card" *ngFor="let report of customerReports">
              <div class="report-header">
                <div class="report-info">
                  <h4>{{ report.reportType }} Report</h4>
                  <span class="report-id">ID: {{ report.reportId }}</span>
                </div>
                <div class="report-status">
                  <span class="status-badge" [class]="'badge-' + report.status.toLowerCase()">
                    {{ report.status }}
                  </span>
                </div>
              </div>

              <div class="report-stats">
                <div class="stat">
                  <span class="stat-label">Projects Found:</span>
                  <span class="stat-value">{{ report.totalFIMatches }}</span>
                </div>
                <div class="stat">
                  <span class="stat-label">Sent:</span>
                  <span class="stat-value">{{ report.sentAt | date:'short' || 'Not sent' }}</span>
                </div>
                <div class="stat">
                  <span class="stat-label">Delivery Status:</span>
                  <span class="stat-value" [class]="'status-' + report.lastDeliveryStatus?.toLowerCase()">
                    {{ report.lastDeliveryStatus || 'Pending' }}
                  </span>
                </div>
              </div>

              <div class="report-actions">
                <button class="btn btn-sm btn-info" (click)="viewReportDetails(report)">
                  <app-icon name="eye" [size]="14"></app-icon> View Details
                </button>
                <button class="btn btn-sm btn-warning" (click)="openResendModal(report)" *ngIf="report.canResend">
                  <app-icon name="repeat" [size]="14"></app-icon> Resend
                </button>
                <button class="btn btn-sm btn-success" (click)="openSendToOthersModal(report)">
                  <app-icon name="send" [size]="14"></app-icon> Send to Others
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Resend/Send to Others Modal -->
    <div class="modal" *ngIf="showResendModal" (click)="closeResendModal()">
      <div class="modal-content modal-send" (click)="$event.stopPropagation()">
        <div class="modal-header">
          <h2><app-icon name="send" [size]="18"></app-icon> Send Report</h2>
          <div class="send-header-meta" *ngIf="selectedReport">
            {{ selectedReport.reportType === 'BATCH_FI_NOTIFICATION' ? 'Batch' : 'FI Detection' }}
            · {{ selectedReport.totalFIMatches }} matches
          </div>
          <button class="close-btn" (click)="closeResendModal()">×</button>
        </div>

        <div class="send-subject-bar">
          <label>Subject</label>
          <input type="text" class="form-control" [(ngModel)]="resendSubject"
                 placeholder="Leave blank for default subject" [disabled]="resendLoading">
        </div>

        <div class="send-panels">
          <!-- Left: Recipients -->
          <div class="send-panel send-panel-recipients">
            <div class="panel-header">
              <span class="panel-title">Recipients</span>
              <span class="panel-count" *ngIf="resendRecipients.length">{{ resendRecipients.length }} selected</span>
            </div>

            <div class="recipient-chips" *ngIf="resendRecipients.length">
              <span class="chip" *ngFor="let r of resendRecipients">
                <span class="chip-label" [title]="r">{{ r }}</span>
                <button class="chip-remove" (click)="removeRecipient(r)" [disabled]="resendLoading">×</button>
              </span>
            </div>

            <div class="recipient-search">
              <app-icon name="search" [size]="13"></app-icon>
              <input type="text" [(ngModel)]="recipientSearch" placeholder="Search customers…" [disabled]="resendLoading">
            </div>

            <div class="recipient-list">
              <label class="recipient-row" *ngFor="let c of filteredAvailableCustomers">
                <input type="checkbox"
                       [checked]="isRecipientSelected(c.email)"
                       (change)="toggleCustomerRecipient(c.email)"
                       [disabled]="resendLoading">
                <span class="recipient-info">
                  <span class="recipient-name">{{ c.name }}</span>
                  <span class="recipient-email">{{ c.email }}</span>
                </span>
              </label>
              <div *ngIf="filteredAvailableCustomers.length === 0" class="no-results">No customers match</div>
            </div>

            <div class="custom-email-add">
              <input type="email" class="form-control" [(ngModel)]="customEmailInput"
                     placeholder="Add any email address…" [disabled]="resendLoading"
                     (keyup.enter)="addCustomEmail()">
              <button class="btn btn-secondary" (click)="addCustomEmail()"
                      [disabled]="!customEmailInput.trim() || resendLoading">Add</button>
            </div>
          </div>

          <!-- Right: Matches -->
          <div class="send-panel send-panel-matches">
            <div class="panel-header">
              <span class="panel-title">Matches to include</span>
              <div class="matches-actions" *ngIf="resendProjects.length && !resendProjectsLoading">
                <button type="button" class="link-btn" (click)="setAllMatches(true)" [disabled]="resendLoading">All</button>
                <span class="sep">·</span>
                <button type="button" class="link-btn" (click)="setAllMatches(false)" [disabled]="resendLoading">None</button>
              </div>
            </div>

            <div *ngIf="resendProjectsLoading" class="panel-loading">
              <app-icon name="loader" [size]="16" [spin]="true"></app-icon> Loading matches…
            </div>
            <div *ngIf="!resendProjectsLoading && resendProjects.length === 0" class="panel-empty">No matches available for this report.</div>

            <div class="match-cards" *ngIf="!resendProjectsLoading && resendProjects.length > 0">
              <label class="match-card" *ngFor="let p of resendProjects" [class.match-card-included]="p.include">
                <input type="checkbox" [(ngModel)]="p.include" [disabled]="resendLoading">
                <div class="match-card-body">
                  <div class="match-card-title">{{ p.planningTitle || p.projectId }}</div>
                  <div class="match-card-meta">
                    <span *ngIf="p.planningStage" class="meta-tag">{{ p.planningStage }}</span>
                    <span *ngIf="p.planningCounty" class="meta-tag">{{ p.planningCounty }}</span>
                    <span *ngIf="p.planningValue" class="meta-tag value-tag">€{{ p.planningValue | number }}</span>
                  </div>
                  <div class="match-card-indicators" *ngIf="p.fiIndicators?.length">
                    <span class="indicator-tag" *ngFor="let ind of p.fiIndicators">{{ ind }}</span>
                  </div>
                </div>
              </label>
            </div>

            <div class="matches-count" *ngIf="!resendProjectsLoading && resendProjects.length > 0">
              {{ selectedMatchCount }} of {{ resendProjects.length }} selected
            </div>
          </div>
        </div>

        <div class="modal-footer">
          <div class="send-summary">
            <span *ngIf="resendRecipients.length">
              <strong>{{ resendRecipients.length }}</strong> recipient{{ resendRecipients.length === 1 ? '' : 's' }}
            </span>
            <span *ngIf="resendRecipients.length && !resendProjectsLoading && resendProjects.length > 0">·</span>
            <span *ngIf="!resendProjectsLoading && resendProjects.length > 0">
              <strong>{{ selectedMatchCount }}</strong> match{{ selectedMatchCount === 1 ? '' : 'es' }}
            </span>
            <span *ngIf="resendRecipients.length === 0" class="send-summary-hint">Select at least one recipient</span>
          </div>
          <div class="modal-actions" style="margin-top:0">
            <button class="btn btn-secondary" (click)="closeResendModal()" [disabled]="resendLoading">Cancel</button>
            <button class="btn btn-primary" (click)="sendReport()"
                    [disabled]="resendRecipients.length === 0 || resendLoading || selectedMatchCount === 0">
              <span *ngIf="resendLoading"><app-icon name="loader" [size]="14" [spin]="true"></app-icon> Sending…</span>
              <span *ngIf="!resendLoading">
                <app-icon name="send" [size]="14"></app-icon>
                Send to {{ resendRecipients.length || 0 }} recipient{{ resendRecipients.length === 1 ? '' : 's' }}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Report Details Modal -->
    <div class="modal" *ngIf="showDetailsModal" (click)="closeDetailsModal()">
      <div class="modal-content modal-lg" (click)="$event.stopPropagation()">
        <div class="modal-header">
          <h2><app-icon name="file-text" [size]="18"></app-icon> Report Details</h2>
          <button class="close-btn" (click)="closeDetailsModal()">×</button>
        </div>
        <div class="modal-body">
          <div *ngIf="detailsLoading" class="loading-spinner">
            <app-icon name="loader" [size]="18" [spin]="true"></app-icon> Loading report details…
          </div>

          <div *ngIf="!detailsLoading && reportDetails">
            <div class="report-summary">
              <span><strong>{{ reportDetails.reportType }} Report</strong></span>
              <span class="projects-count">ID: {{ reportDetails.reportId }}</span>
            </div>

            <div class="report-stats">
              <div class="stat">
                <span class="stat-label">Status:</span>
                <span class="stat-value">{{ reportDetails.status }}</span>
              </div>
              <div class="stat">
                <span class="stat-label">Customer:</span>
                <span class="stat-value">{{ reportDetails.customerName || '—' }}</span>
              </div>
              <div class="stat">
                <span class="stat-label">Email:</span>
                <span class="stat-value">{{ reportDetails.customerEmail || '—' }}</span>
              </div>
              <div class="stat">
                <span class="stat-label">Projects Scanned:</span>
                <span class="stat-value">{{ reportDetails.totalProjectsScanned ?? 0 }}</span>
              </div>
              <div class="stat">
                <span class="stat-label">FI Matches:</span>
                <span class="stat-value">{{ reportDetails.totalFIMatches ?? 0 }}</span>
              </div>
              <div class="stat">
                <span class="stat-label">Generated:</span>
                <span class="stat-value">{{ reportDetails.generatedAt ? (reportDetails.generatedAt | date:'short') : '—' }}</span>
              </div>
              <div class="stat">
                <span class="stat-label">Sent:</span>
                <span class="stat-value">{{ reportDetails.sentAt ? (reportDetails.sentAt | date:'short') : 'Not sent' }}</span>
              </div>
              <div class="stat">
                <span class="stat-label">Delivery Attempts:</span>
                <span class="stat-value">{{ reportDetails.deliveryAttempts?.length ?? 0 }}</span>
              </div>
            </div>

            <div class="form-group" *ngIf="reportDetails.emailData?.subject">
              <label>Email Subject:</label>
              <div class="detail-text">{{ reportDetails.emailData.subject }}</div>
            </div>

            <div class="form-group">
              <label>Projects Found ({{ reportDetails.projectsFound?.length || 0 }}):</label>
              <div *ngIf="!reportDetails.projectsFound?.length" class="empty-state">
                <span>No project details available for this report.</span>
              </div>
              <div class="projects-detail-list" *ngIf="reportDetails.projectsFound?.length">
                <div class="project-detail-card" *ngFor="let project of reportDetails.projectsFound">
                  <div class="project-detail-header">
                    <span class="project-detail-title">{{ project.planningTitle || project.projectId }}</span>
                    <a *ngIf="project.biiUrl" [href]="project.biiUrl" target="_blank" rel="noopener" class="project-detail-link">
                      <app-icon name="eye" [size]="12"></app-icon> View
                    </a>
                  </div>
                  <div class="project-detail-meta">
                    <span *ngIf="project.projectId">ID: {{ project.projectId }}</span>
                    <span *ngIf="project.planningStage">Stage: {{ project.planningStage }}</span>
                    <span *ngIf="project.planningCounty">County: {{ project.planningCounty }}</span>
                    <span *ngIf="project.planningValue">Value: {{ project.planningValue | currency:'EUR':'symbol':'1.0-0' }}</span>
                  </div>
                  <div class="project-detail-tags" *ngIf="project.matchedKeywords?.length">
                    <span class="tag" *ngFor="let kw of project.matchedKeywords">{{ kw }}</span>
                  </div>
                </div>
              </div>
            </div>

            <div class="modal-actions">
              <button class="btn btn-secondary" (click)="closeDetailsModal()">Close</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Edit Customer Modal -->
    <div class="modal" *ngIf="showEditModal" (click)="closeEditModal()">
      <div class="modal-content" (click)="$event.stopPropagation()">
        <div class="modal-header">
          <h2><app-icon name="edit" [size]="18"></app-icon> Edit Customer</h2>
          <button class="close-btn" (click)="closeEditModal()">×</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label for="edit-name">Name *</label>
            <input
              id="edit-name"
              type="text"
              class="form-control"
              [(ngModel)]="editingCustomer.name"
              placeholder="Enter customer name"
              [disabled]="isUpdating"
            >
          </div>

          <div class="form-group">
            <label for="edit-email">Email *</label>
            <input
              id="edit-email"
              type="email"
              class="form-control"
              [(ngModel)]="editingCustomer.email"
              placeholder="Enter email address"
              [disabled]="isUpdating"
            >
          </div>

          <div class="form-group">
            <label for="edit-phone">Phone</label>
            <input
              id="edit-phone"
              type="text"
              class="form-control"
              [(ngModel)]="editingCustomer.phone"
              placeholder="Enter phone number (optional)"
              [disabled]="isUpdating"
            >
          </div>

          <div class="form-group">
            <label for="edit-company">Company</label>
            <input
              id="edit-company"
              type="text"
              class="form-control"
              [(ngModel)]="editingCustomer.company"
              placeholder="Enter company name (optional)"
              [disabled]="isUpdating"
            >
          </div>

          <!-- Subscription Filters -->
          <div class="filter-section">
            <h4><app-icon name="map-pin" [size]="15"></app-icon> Subscription Filters</h4>
            <p class="filter-help">Select which counties and sectors this customer should receive. Leave empty to receive all results.</p>

            <div class="form-group">
              <label>Quick Select by Province</label>
              <div class="province-buttons" *ngIf="dropdownData?.provinces">
                <button
                  *ngFor="let province of dropdownData!.provinces"
                  type="button"
                  class="btn btn-sm province-btn"
                  [class.selected]="isProvinceFullySelected(province)"
                  [class.partial]="isProvincePartiallySelected(province)"
                  (click)="toggleProvinceFilter(province)"
                  [disabled]="isUpdating"
                >
                  {{ province.name }}
                </button>
                <button
                  type="button"
                  class="btn btn-sm btn-outline clear-btn"
                  (click)="clearAllCountyFilters()"
                  [disabled]="isUpdating || editingCustomer.filters.allowedCounties.length === 0"
                >
                  Clear All
                </button>
              </div>
            </div>

            <div class="form-group">
              <label>Counties ({{ editingCustomer.filters.allowedCounties.length }} selected)</label>
              <div class="filter-chips" *ngIf="dropdownData">
                <button
                  *ngFor="let county of dropdownData.counties"
                  type="button"
                  class="filter-chip"
                  [class.selected]="isCountySelected(county.name)"
                  (click)="toggleCountyFilter(county.name)"
                  [disabled]="isUpdating"
                >
                  {{ county.name }}
                </button>
              </div>
              <div *ngIf="!dropdownData" class="loading-filters">Loading counties...</div>
            </div>

            <div class="form-group">
              <label>Sectors</label>
              <div class="filter-chips" *ngIf="dropdownData">
                <button
                  *ngFor="let category of dropdownData.categories"
                  type="button"
                  class="filter-chip sector"
                  [class.selected]="isSectorSelected(category.name)"
                  (click)="toggleSectorFilter(category.name)"
                  [disabled]="isUpdating"
                >
                  {{ category.name }}
                </button>
              </div>
              <div *ngIf="!dropdownData" class="loading-filters">Loading sectors...</div>
            </div>
          </div>

          <div class="modal-actions">
            <button class="btn btn-secondary" (click)="closeEditModal()" [disabled]="isUpdating">
              Cancel
            </button>
            <button
              class="btn btn-primary"
              (click)="saveCustomerEdit()"
              [disabled]="!editingCustomer.name || !editingCustomer.email || isUpdating"
            >
              <span *ngIf="isUpdating"><app-icon name="loader" [size]="14" [spin]="true"></app-icon> Saving…</span>
              <span *ngIf="!isUpdating"><app-icon name="save" [size]="14"></app-icon> Save Changes</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Delete Confirmation Modal -->
    <div class="modal" *ngIf="showDeleteModal" (click)="closeDeleteModal()">
      <div class="modal-content" (click)="$event.stopPropagation()">
        <div class="modal-header modal-danger">
          <h2><app-icon name="trash" [size]="18"></app-icon> Delete Customer</h2>
          <button class="close-btn" (click)="closeDeleteModal()">×</button>
        </div>
        <div class="modal-body">
          <div class="warning-message">
            <div class="warning-icon">⚠️</div>
            <h3>Are you sure you want to delete this customer?</h3>
            <p class="customer-details" *ngIf="customerToDelete">
              <strong>{{ customerToDelete.name }}</strong><br>
              {{ customerToDelete.email }}
            </p>
            <div class="warning-text">
              <p>This action will permanently delete:</p>
              <ul>
                <li>Customer account and profile</li>
                <li>All FI reports sent to this customer</li>
                <li>Email notification history</li>
                <li>All associated records</li>
              </ul>
              <p class="danger-note"><strong>⚠️ This action cannot be undone!</strong></p>
            </div>
          </div>

          <div class="modal-actions">
            <button class="btn btn-secondary" (click)="closeDeleteModal()" [disabled]="isUpdating">
              Cancel
            </button>
            <button
              class="btn btn-danger"
              (click)="confirmDeleteCustomer()"
              [disabled]="isUpdating"
            >
              <span *ngIf="isUpdating">🔄 Deleting...</span>
              <span *ngIf="!isUpdating">🗑️ Yes, Delete Customer</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .customers-container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 2rem;
    }

    .page-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2rem;
    }

    .page-header h1 {
      margin: 0;
      color: var(--text-primary);
      font-size: 2rem;
    }

    .btn {
      border: none;
      border-radius: 4px;
      padding: 0.5rem 1rem;
      font-size: 0.9rem;
      cursor: pointer;
      transition: all 0.3s;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      text-decoration: none;
    }

    .btn-primary {
      background: var(--primary);
      color: var(--text-inverse);
    }

    .btn-primary:hover {
      background: var(--primary-hover);
    }

    .btn-secondary {
      background: var(--bg-tertiary);
      color: var(--text-primary);
    }

    .btn-success {
      background: var(--success);
      color: var(--text-inverse);
    }

    .btn-warning {
      background: var(--warning);
      color: var(--warning-btn-text);
    }

    .btn-danger {
      background: var(--error);
      color: var(--text-inverse);
    }

    .btn-danger:hover {
      filter: brightness(0.9);
    }

    .btn-info {
      background: var(--info);
      color: var(--text-inverse);
    }

    .btn-info:hover {
      filter: brightness(0.9);
    }

    .btn-sm {
      padding: 0.25rem 0.5rem;
      font-size: 0.8rem;
    }

    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .loading {
      text-align: center;
      padding: 3rem;
      color: var(--text-secondary);
    }

    .spinner {
      width: 24px;
      height: 24px;
      border: 2px solid var(--border-color);
      border-top: 2px solid var(--primary);
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 1rem;
    }

    .spinner.large {
      width: 40px;
      height: 40px;
    }

    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }

    .customers-list {
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
    }

    .customer-card {
      background: var(--bg-card);
      border-radius: 8px;
      box-shadow: var(--shadow-md);
      overflow: hidden;
      border: 1px solid var(--border-color);
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1.5rem;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border-color);
    }

    .customer-info h3 {
      margin: 0 0 0.25rem 0;
      color: var(--text-primary);
      font-size: 1.3rem;
    }

    .customer-email {
      color: var(--text-secondary);
      font-size: 0.9rem;
    }

    .status-badge {
      padding: 0.25rem 0.75rem;
      border-radius: 12px;
      font-size: 0.8rem;
      font-weight: 500;
      text-transform: uppercase;
    }

    .status-active {
      background: var(--success-bg);
      color: var(--success-text);
    }

    .status-inactive {
      background: var(--error-bg);
      color: var(--error-text);
    }

    .card-body {
      padding: 1.5rem;
    }

    .customer-details {
      margin-bottom: 1rem;
    }

    .detail-item {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 0.5rem;
    }

    .detail-label {
      font-weight: 500;
      color: var(--text-secondary);
      min-width: 60px;
    }

    .detail-value {
      color: var(--text-primary);
    }

    .subscriptions h4 {
      margin: 0 0 0.75rem 0;
      color: var(--text-primary);
      font-size: 1rem;
    }

    .subscription-list {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }

    .subscription-tag {
      background: var(--primary-light);
      color: var(--primary);
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      font-size: 0.8rem;
      font-weight: 500;
    }

    .card-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1rem 1.5rem;
      background: var(--bg-secondary);
      border-top: 1px solid var(--border-color);
    }

    .customer-dates {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .created-date,
    .notification-date {
      font-size: 0.8rem;
      color: var(--text-secondary);
    }

    .card-actions {
      display: flex;
      gap: 0.5rem;
    }

    .no-customers {
      text-align: center;
      padding: 4rem 2rem;
    }

    .no-customers-content {
      max-width: 400px;
      margin: 0 auto;
    }

    .no-customers-icon {
      font-size: 4rem;
      margin-bottom: 1rem;
    }

    .no-customers h3 {
      margin: 0 0 1rem 0;
      color: var(--text-primary);
    }

    .no-customers p {
      margin: 0 0 2rem 0;
      color: var(--text-secondary);
      line-height: 1.6;
    }

    /* Modal styles */
    .modal {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: var(--modal-overlay);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .modal-content {
      background: var(--bg-card);
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
      padding: 1.5rem;
      border-bottom: 1px solid var(--border-color);
    }

    .modal-header h2 {
      margin: 0;
      color: var(--text-primary);
    }

    .close-btn {
      background: none;
      border: none;
      font-size: 1.5rem;
      cursor: pointer;
      color: var(--text-secondary);
      padding: 0;
      width: 30px;
      height: 30px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .close-btn:hover {
      color: var(--text-primary);
    }

    .modal-body {
      padding: 1.5rem;
    }

    .modal-footer {
      padding: 1rem 1.5rem;
      border-top: 1px solid var(--border-color);
      display: flex;
      justify-content: flex-end;
      gap: 1rem;
    }

    @media (max-width: 768px) {
      .customers-container {
        padding: 1rem;
      }

      .page-header {
        flex-direction: column;
        gap: 1rem;
        align-items: stretch;
      }

      .card-header,
      .card-footer {
        flex-direction: column;
        gap: 1rem;
        align-items: stretch;
      }

      .card-actions {
        justify-content: center;
      }
    }

    /* Reports Modal Styles */
    .modal-lg {
      width: 90%;
      max-width: 900px;
    }

    .modal-customer-info {
      display: flex;
      flex-direction: column;
      align-items: center;
      margin: 0 20px;
    }

    .customer-name {
      font-weight: bold;
      color: var(--text-primary);
    }

    .customer-email {
      font-size: 0.9rem;
      color: var(--text-secondary);
    }

    .loading-spinner {
      text-align: center;
      padding: 40px;
      font-size: 1.1rem;
      color: var(--text-secondary);
    }

    .empty-state {
      text-align: center;
      padding: 60px;
      font-size: 1.1rem;
      color: var(--text-secondary);
    }

    .reports-summary {
      margin-bottom: 20px;
      padding-bottom: 15px;
      border-bottom: 2px solid var(--border-color);
    }

    .reports-summary h3 {
      margin: 0;
      color: var(--text-primary);
    }

    .report-card {
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 15px;
      background: var(--bg-secondary);
    }

    .report-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 15px;
    }

    .report-info h4 {
      margin: 0 0 5px 0;
      color: var(--text-primary);
    }

    .report-id {
      font-size: 0.8rem;
      color: var(--text-secondary);
      font-family: monospace;
    }

    .status-badge {
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 0.8rem;
      font-weight: 600;
      text-transform: uppercase;
    }

    .badge-sent {
      background: var(--success-bg);
      color: var(--success-text);
    }

    .badge-failed {
      background: var(--error-bg);
      color: var(--error-text);
    }

    .badge-pending {
      background: var(--warning-bg);
      color: var(--warning-text);
    }

    .report-stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 15px;
      margin-bottom: 15px;
    }

    .stat {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
    }

    .stat-label {
      font-size: 0.8rem;
      color: var(--text-secondary);
      font-weight: 500;
    }

    .stat-value {
      font-weight: 600;
      color: var(--text-primary);
      overflow-wrap: anywhere;
      word-break: break-word;
      min-width: 0;
    }

    .status-success {
      color: var(--success);
    }

    .status-failed {
      color: var(--error);
    }

    .status-pending {
      color: var(--warning);
    }

    .report-actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }

    .report-summary {
      background: var(--bg-secondary);
      padding: 15px;
      border-radius: 6px;
      margin-bottom: 20px;
      border-left: 4px solid var(--primary);
    }

    .projects-count {
      display: block;
      font-size: 0.9rem;
      color: var(--text-secondary);
      margin-top: 5px;
    }

    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 20px;
    }

    .detail-text {
      padding: 10px 12px;
      background: var(--bg-secondary);
      border-radius: 6px;
      color: var(--text-primary);
      font-size: 0.9rem;
    }

    .projects-detail-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-height: 320px;
      overflow-y: auto;
    }

    .project-detail-card {
      padding: 12px;
      background: var(--bg-secondary);
      border-radius: 6px;
      border-left: 3px solid var(--primary);
    }

    .project-detail-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      margin-bottom: 6px;
    }

    .project-detail-title {
      font-weight: 600;
      color: var(--text-primary);
    }

    .project-detail-link {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 0.8rem;
      color: var(--primary);
      text-decoration: none;
      white-space: nowrap;
    }

    .project-detail-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      font-size: 0.8rem;
      color: var(--text-secondary);
    }

    .project-detail-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }

    .project-detail-tags .tag {
      padding: 2px 8px;
      background: var(--primary);
      color: #fff;
      border-radius: 10px;
      font-size: 0.72rem;
    }

    .matches-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
    }

    .matches-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .matches-actions .sep {
      color: var(--text-secondary);
    }

    .link-btn {
      background: none;
      border: none;
      padding: 0;
      color: var(--primary);
      cursor: pointer;
      font-size: 0.8rem;
    }

    .link-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .matches-select-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 240px;
      overflow-y: auto;
      border: 1px solid var(--border, #e0e0e0);
      border-radius: 6px;
      padding: 6px;
    }

    .match-row {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 6px 8px;
      border-radius: 4px;
      cursor: pointer;
    }

    .match-row:hover {
      background: var(--bg-secondary);
    }

    .match-row input[type="checkbox"] {
      margin-top: 3px;
    }

    .match-row-text {
      display: flex;
      flex-direction: column;
    }

    .match-row-title {
      color: var(--text-primary);
      font-size: 0.9rem;
    }

    .match-row-meta {
      color: var(--text-secondary);
      font-size: 0.78rem;
    }

    .matches-count {
      display: block;
      margin-top: 6px;
      font-size: 0.78rem;
      color: var(--text-secondary);
    }

    /* Two-panel send modal */
    .modal-content.modal-send {
      max-width: 980px;
      display: flex;
      flex-direction: column;
      max-height: 90vh;
      overflow: hidden;
    }
    .send-header-meta {
      flex: 1;
      text-align: center;
      font-size: 0.82rem;
      color: var(--text-secondary);
    }
    .send-subject-bar {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 20px;
      border-bottom: 1px solid var(--border, #ececec);
      flex-shrink: 0;
    }
    .send-subject-bar label {
      white-space: nowrap;
      font-size: 0.85rem;
      font-weight: 500;
      color: var(--text-secondary);
      margin: 0;
    }
    .send-subject-bar .form-control { flex: 1; margin: 0; }
    .send-panels {
      display: flex;
      flex: 1;
      overflow: hidden;
      min-height: 400px;
    }
    .send-panel {
      display: flex;
      flex-direction: column;
      padding: 16px;
      overflow: hidden;
    }
    .send-panel-recipients {
      border-right: 1px solid var(--border, #ececec);
      width: 340px;
      flex-shrink: 0;
    }
    .send-panel-matches { flex: 1; min-width: 0; }
    .panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }
    .panel-title { font-weight: 600; color: var(--text-primary); font-size: 0.9rem; }
    .panel-count { font-size: 0.78rem; color: var(--primary); font-weight: 600; }
    .recipient-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin-bottom: 10px;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px 3px 10px;
      background: var(--primary);
      color: #fff;
      border-radius: 12px;
      font-size: 0.75rem;
      max-width: 220px;
    }
    .chip-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .chip-remove {
      background: none;
      border: none;
      color: rgba(255,255,255,0.8);
      cursor: pointer;
      padding: 0 0 0 2px;
      font-size: 1rem;
      line-height: 1;
      flex-shrink: 0;
    }
    .chip-remove:hover:not(:disabled) { color: #fff; }
    .recipient-search {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      background: var(--bg-secondary);
      border: 1px solid var(--border, #e0e0e0);
      border-radius: 6px;
      margin-bottom: 8px;
      color: var(--text-secondary);
      flex-shrink: 0;
    }
    .recipient-search input {
      border: none;
      background: transparent;
      outline: none;
      flex: 1;
      color: var(--text-primary);
      font-size: 0.85rem;
    }
    .recipient-list {
      flex: 1;
      overflow-y: auto;
      border: 1px solid var(--border, #e0e0e0);
      border-radius: 6px;
      margin-bottom: 10px;
    }
    .recipient-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      cursor: pointer;
      border-bottom: 1px solid var(--border, #f0f0f0);
    }
    .recipient-row:last-child { border-bottom: none; }
    .recipient-row:hover { background: var(--bg-secondary); }
    .recipient-info { display: flex; flex-direction: column; min-width: 0; }
    .recipient-name { font-weight: 500; color: var(--text-primary); font-size: 0.85rem; }
    .recipient-email { font-size: 0.75rem; color: var(--text-secondary); overflow-wrap: anywhere; }
    .custom-email-add { display: flex; gap: 8px; flex-shrink: 0; }
    .custom-email-add .form-control { flex: 1; margin: 0; }
    .no-results { padding: 14px; text-align: center; color: var(--text-secondary); font-size: 0.82rem; }
    .panel-loading, .panel-empty {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 40px 16px;
      color: var(--text-secondary);
      font-size: 0.85rem;
    }
    .match-cards {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 6px;
      border: 1px solid var(--border, #e0e0e0);
      border-radius: 6px;
      padding: 6px;
      margin-bottom: 6px;
    }
    .match-card {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 10px;
      border-radius: 6px;
      cursor: pointer;
      border: 1px solid transparent;
    }
    .match-card:hover { background: var(--bg-secondary); }
    .match-card-included {
      background: var(--bg-secondary);
      border-color: var(--primary) !important;
    }
    .match-card input[type="checkbox"] { margin-top: 3px; flex-shrink: 0; }
    .match-card-body { flex: 1; min-width: 0; }
    .match-card-title {
      font-weight: 500;
      color: var(--text-primary);
      font-size: 0.88rem;
      margin-bottom: 4px;
      overflow-wrap: anywhere;
    }
    .match-card-meta { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px; }
    .meta-tag {
      padding: 1px 7px;
      background: var(--bg-secondary);
      border: 1px solid var(--border, #e0e0e0);
      color: var(--text-secondary);
      border-radius: 8px;
      font-size: 0.72rem;
    }
    .value-tag { color: var(--primary); border-color: var(--primary); }
    .match-card-indicators { display: flex; flex-wrap: wrap; gap: 4px; }
    .indicator-tag {
      padding: 1px 7px;
      background: rgba(99,102,241,0.12);
      color: var(--primary);
      border-radius: 8px;
      font-size: 0.7rem;
    }
    .modal-footer {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 14px 20px;
      border-top: 1px solid var(--border, #ececec);
      flex-shrink: 0;
    }
    .send-summary {
      flex: 1;
      color: var(--text-secondary);
      font-size: 0.85rem;
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .send-summary strong { color: var(--text-primary); }
    .send-summary-hint { color: var(--error); font-size: 0.82rem; }

    .form-group {
      margin-bottom: 20px;
    }

    .form-group label {
      display: block;
      margin-bottom: 8px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .form-control {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      font-size: 1rem;
      transition: border-color 0.15s ease-in-out;
      background: var(--bg-input);
      color: var(--text-primary);
    }

    .form-control:focus {
      outline: none;
      border-color: var(--primary);
      box-shadow: 0 0 0 2px var(--primary-light);
    }

    /* Edit and Delete Modal Styles */
    .form-group {
      margin-bottom: 1.5rem;
    }

    .form-group label {
      display: block;
      margin-bottom: 0.5rem;
      font-weight: 500;
      color: var(--text-primary);
    }

    .modal-danger .modal-header {
      background: var(--error-bg);
      border-bottom-color: var(--error);
    }

    .warning-message {
      text-align: center;
      padding: 1rem;
    }

    .warning-icon {
      font-size: 4rem;
      margin-bottom: 1rem;
    }

    .warning-message h3 {
      color: var(--error);
      margin-bottom: 1rem;
    }

    .customer-details {
      background: var(--bg-secondary);
      padding: 1rem;
      border-radius: 4px;
      margin: 1rem 0;
      font-size: 1rem;
    }

    .warning-text {
      text-align: left;
      margin-top: 1.5rem;
      padding: 1rem;
      background: var(--warning-bg);
      border-left: 4px solid var(--warning);
      border-radius: 4px;
    }

    .warning-text ul {
      margin: 1rem 0;
      padding-left: 1.5rem;
    }

    .warning-text li {
      margin: 0.5rem 0;
    }

    .danger-note {
      margin-top: 1rem;
      color: var(--error);
      font-size: 1.1rem;
    }

    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 0.5rem;
      margin-top: 1.5rem;
    }

    @media (max-width: 768px) {
      .modal-lg {
        width: 95%;
        margin: 10px;
      }

      .modal-customer-info {
        margin: 10px 0;
      }

      .report-header {
        flex-direction: column;
        align-items: flex-start;
        gap: 10px;
      }

      .report-stats {
        grid-template-columns: 1fr;
      }

      .report-actions {
        justify-content: center;
      }

      .modal-actions {
        flex-direction: column;
      }

      .card-actions {
        flex-wrap: wrap;
      }

      .btn-sm {
        font-size: 0.7rem;
        padding: 0.2rem 0.4rem;
      }
    }

    /* Subscription Filters - Customer Card */
    .subscription-filters {
      margin-top: 0.75rem;
      padding-top: 0.75rem;
      border-top: 1px solid var(--border-color);
    }

    .filter-badges {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .filter-group {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem;
      align-items: center;
    }

    .filter-label {
      font-size: 0.75rem;
      color: var(--text-secondary);
      font-weight: 500;
      min-width: 60px;
    }

    .filter-badge {
      display: inline-block;
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 500;
    }

    .filter-badge.county {
      background: var(--primary-light);
      color: var(--primary);
    }

    .filter-badge.sector {
      background: var(--warning-bg);
      color: var(--warning-text);
    }

    .filter-badge.all {
      background: var(--success-bg);
      color: var(--success-text);
    }

    .no-restrictions {
      font-size: 0.85rem;
    }

    /* Filter Section - Edit Modal */
    .filter-section {
      margin-top: 1.5rem;
      padding: 1rem;
      background: var(--bg-secondary);
      border-radius: 8px;
      border: 1px solid var(--border-color);
    }

    .filter-section h4 {
      margin: 0 0 0.5rem 0;
      color: var(--text-primary);
      font-size: 1rem;
    }

    .filter-help {
      margin: 0 0 1rem 0;
      font-size: 0.85rem;
      color: var(--text-secondary);
    }

    .filter-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      max-height: 200px;
      overflow-y: auto;
      padding: 0.5rem;
      background: var(--bg-input);
      border-radius: 4px;
      border: 1px solid var(--border-color);
    }

    .filter-chip {
      padding: 0.35rem 0.75rem;
      border-radius: 16px;
      font-size: 0.8rem;
      font-weight: 500;
      border: 1px solid var(--border-color);
      background: var(--bg-card);
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .filter-chip:hover:not(:disabled) {
      background: var(--bg-tertiary);
    }

    .filter-chip.selected {
      background: var(--primary);
      color: var(--text-inverse);
      border-color: var(--primary);
    }

    .filter-chip.sector.selected {
      background: #b8860b;
      border-color: #b8860b;
    }

    .filter-chip:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    /* Province quick-select buttons */
    .province-buttons {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-bottom: 1rem;
    }

    .province-btn {
      padding: 0.4rem 0.75rem;
      border-radius: 6px;
      font-size: 0.85rem;
      font-weight: 500;
      border: 2px solid var(--success);
      background: var(--bg-card);
      color: var(--success);
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .province-btn:hover:not(:disabled) {
      background: var(--success-bg);
    }

    .province-btn.selected {
      background: var(--success);
      color: var(--text-inverse);
    }

    .province-btn.partial {
      background: linear-gradient(135deg, var(--success) 50%, var(--bg-card) 50%);
      color: var(--success);
    }

    .province-btn.partial:hover {
      background: linear-gradient(135deg, var(--success) 50%, var(--success-bg) 50%);
    }

    .clear-btn {
      border-color: var(--error);
      color: var(--error);
    }

    .clear-btn:hover:not(:disabled) {
      background: var(--error-bg);
    }

    .clear-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .loading-filters {
      padding: 1rem;
      text-align: center;
      color: var(--text-secondary);
      font-size: 0.9rem;
    }
  `]
})
export class CustomerListComponent implements OnInit {
  customers: Customer[] = [];
  isLoading = false;
  isUpdating = false;
  isCreatingCustomer = false;
  showAddCustomer = false;
  availableReportTypes = [
    { value: 'acoustic', label: 'Acoustic' },
    { value: 'transport', label: 'Transport' },
    { value: 'ecological', label: 'Ecological' },
    { value: 'flood', label: 'Flood' },
    { value: 'heritage', label: 'Heritage' },
    { value: 'arboricultural', label: 'Arboricultural' },
    { value: 'waste', label: 'Waste' },
    { value: 'lighting', label: 'Lighting' }
  ];
  newCustomer: CustomerRequest = {
    name: '',
    email: '',
    company: '',
    phone: '',
    projectId: '',
    reportTypes: ['acoustic']
  };

  // Search and filtering
  searchQuery = '';
  selectedReportType = '';
  selectedStatus = '';
  searchTimeout: any;

  // Pagination (client-side over the filtered result set)
  currentPage = 1;
  pageSize = 25;

  // Customer history modal
  showHistoryModal = false;
  selectedCustomerHistory: CustomerHistory | null = null;
  historyLoading = false;

  // Quick select modal
  showQuickSelectModal = false;
  quickSelectedCustomer: Customer | null = null;

  // Reports modal
  showReportsModal = false;
  selectedCustomerForReports: Customer | null = null;
  customerReports: any[] = [];
  reportsLoading = false;
  showResendModal = false;
  selectedReport: any = null;
  resendRecipients: string[] = [];
  resendLoading = false;
  availableCustomers: Customer[] = [];
  resendSubject = '';
  resendProjects: any[] = [];
  resendProjectsLoading = false;
  recipientSearch = '';
  customEmailInput = '';

  // Report details modal
  showDetailsModal = false;
  reportDetails: any = null;
  detailsLoading = false;

  // Edit customer modal
  showEditModal = false;
  editingCustomer: any = {
    _id: '',
    name: '',
    email: '',
    phone: '',
    company: '',
    filters: {
      allowedCounties: [] as string[],
      allowedSectors: [] as string[]
    }
  };

  // Dropdown data for filters
  dropdownData: DropdownData | null = null;
  dropdownLoading = false;

  // Delete customer modal
  showDeleteModal = false;
  customerToDelete: Customer | null = null;

  constructor(
    private customerService: CustomerService,
    private apiFilteringService: ApiFilteringService,
    private toastr: ToastrService,
    private http: HttpClient
  ) {}

  private baseUrl = `${environment.apiUrl}/api/reports`; // Backend API URL

  ngOnInit() {
    this.loadCustomers();
    this.loadDropdownData();
  }

  loadDropdownData() {
    this.dropdownLoading = true;
    this.apiFilteringService.getDropdownData().subscribe({
      next: (data) => {
        this.dropdownData = data;
        this.dropdownLoading = false;
      },
      error: (error) => {
        console.error('Error loading dropdown data:', error);
        this.dropdownLoading = false;
      }
    });
  }

  loadCustomers() {
    this.isLoading = true;

    const params: any = {};
    if (this.searchQuery.trim()) {
      params.search = this.searchQuery.trim();
    }
    if (this.selectedReportType) {
      params.reportType = this.selectedReportType;
    }
    if (this.selectedStatus) {
      params.isActive = this.selectedStatus === 'true';
    }

    this.customerService.getCustomers(params).subscribe({
      next: (response) => {
        this.customers = response.customers;
        this.currentPage = 1;
        this.isLoading = false;
      },
      error: (error) => {
        this.isLoading = false;
        this.toastr.error('Failed to load customers');
        console.error('Error loading customers:', error);
      }
    });
  }

  onSearchChange() {
    // Debounce search
    if (this.searchTimeout) {
      clearTimeout(this.searchTimeout);
    }
    this.searchTimeout = setTimeout(() => {
      this.loadCustomers();
    }, 500);
  }

  onFilterChange() {
    this.loadCustomers();
  }

  // ---- Pagination helpers ----
  get totalPages(): number {
    return Math.max(1, Math.ceil(this.customers.length / this.pageSize));
  }

  get pageStart(): number {
    return (this.currentPage - 1) * this.pageSize;
  }

  get pageEnd(): number {
    return Math.min(this.pageStart + this.pageSize, this.customers.length);
  }

  get pagedCustomers(): Customer[] {
    return this.customers.slice(this.pageStart, this.pageEnd);
  }

  goToPage(page: number) {
    this.currentPage = Math.min(Math.max(1, page), this.totalPages);
  }

  nextPage() {
    this.goToPage(this.currentPage + 1);
  }

  prevPage() {
    this.goToPage(this.currentPage - 1);
  }

  onPageSizeChange() {
    this.currentPage = 1;
  }

  toggleCustomerStatus(customerId: string) {
    this.isUpdating = true;
    this.customerService.toggleCustomerStatus(customerId).subscribe({
      next: () => {
        this.isUpdating = false;
        this.toastr.success('Customer status updated successfully');
        this.loadCustomers();
      },
      error: (error) => {
        this.isUpdating = false;
        this.toastr.error('Failed to update customer status');
        console.error('Error updating customer:', error);
      }
    });
  }

  viewCustomerHistory(customerId: string) {
    this.showHistoryModal = true;
    this.historyLoading = true;
    this.selectedCustomerHistory = null;

    this.customerService.getCustomerFIHistory(customerId).subscribe({
      next: (history) => {
        this.selectedCustomerHistory = history;
        this.historyLoading = false;
      },
      error: (error) => {
        this.historyLoading = false;
        this.toastr.error('Failed to load customer history');
        console.error('Error loading customer history:', error);
        this.closeHistoryModal();
      }
    });
  }

  closeHistoryModal() {
    this.showHistoryModal = false;
    this.selectedCustomerHistory = null;
    this.historyLoading = false;
  }

  quickSelectCustomer(customer: Customer) {
    // Copy email to clipboard
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(customer.email).then(() => {
        this.quickSelectedCustomer = customer;
        this.showQuickSelectModal = true;
        this.toastr.success(`Email copied: ${customer.email}`);
      }).catch(() => {
        this.fallbackCopyTextToClipboard(customer.email);
      });
    } else {
      this.fallbackCopyTextToClipboard(customer.email);
    }
  }

  fallbackCopyTextToClipboard(text: string) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.top = '0';
    textArea.style.left = '0';
    textArea.style.position = 'fixed';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    try {
      document.execCommand('copy');
      this.quickSelectedCustomer = { email: text } as Customer;
      this.showQuickSelectModal = true;
      this.toastr.success(`Email copied: ${text}`);
    } catch (err) {
      this.toastr.error('Failed to copy email to clipboard');
    }

    document.body.removeChild(textArea);
  }

  closeQuickSelectModal() {
    this.showQuickSelectModal = false;
    this.quickSelectedCustomer = null;
  }

  openAddCustomerModal() {
    this.showAddCustomer = true;
  }

  closeAddCustomerModal() {
    this.showAddCustomer = false;
    this.isCreatingCustomer = false;
    this.newCustomer = {
      name: '',
      email: '',
      company: '',
      phone: '',
      projectId: '',
      reportTypes: ['acoustic']
    };
  }

  toggleNewCustomerReportType(reportType: string) {
    const reportTypes = this.newCustomer.reportTypes || [];
    const index = reportTypes.indexOf(reportType);

    if (index === -1) {
      reportTypes.push(reportType);
    } else {
      reportTypes.splice(index, 1);
    }

    this.newCustomer.reportTypes = reportTypes;
  }

  isNewCustomerReportTypeSelected(reportType: string): boolean {
    return (this.newCustomer.reportTypes || []).includes(reportType);
  }

  canCreateCustomer(): boolean {
    return !!this.newCustomer.name?.trim() &&
      !!this.newCustomer.email?.trim() &&
      !!this.newCustomer.reportTypes?.length;
  }

  createCustomer() {
    if (!this.canCreateCustomer()) {
      this.toastr.error('Name, email, and at least one report type are required');
      return;
    }

    const payload: CustomerRequest = {
      name: this.newCustomer.name.trim(),
      email: this.newCustomer.email.trim().toLowerCase(),
      company: this.newCustomer.company?.trim() || undefined,
      phone: this.newCustomer.phone?.trim() || undefined,
      projectId: this.newCustomer.projectId?.trim().toUpperCase() || undefined,
      reportTypes: [...(this.newCustomer.reportTypes || [])]
    };

    this.isCreatingCustomer = true;

    this.customerService.createCustomer(payload).subscribe({
      next: (customer) => {
        this.toastr.success(`Customer "${customer.name}" created successfully`);
        this.closeAddCustomerModal();
        this.loadCustomers();
      },
      error: (error) => {
        this.isCreatingCustomer = false;
        this.toastr.error(error.error?.error || error.error?.message || 'Failed to create customer');
        console.error('Error creating customer:', error);
      }
    });
  }

  formatDate(date: Date | string): string {
    if (!date) return 'N/A';
    const d = new Date(date);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  formatReportType(reportType: string): string {
    return reportType.charAt(0).toUpperCase() + reportType.slice(1);
  }

  hasFilters(customer: Customer): boolean {
    return !!(customer.filters?.allowedCounties?.length || customer.filters?.allowedSectors?.length);
  }

  formatStatus(status: string): string {
    switch (status) {
      case 'detected': return 'Detected';
      case 'notified': return 'Notified';
      case 'acknowledged': return 'Acknowledged';
      case 'responded': return 'Responded';
      case 'sent': return 'Sent';
      case 'delivered': return 'Delivered';
      case 'failed': return 'Failed';
      default: return status;
    }
  }

  // Reports Modal Methods
  viewCustomerReports(customer: Customer) {
    this.selectedCustomerForReports = customer;
    this.showReportsModal = true;
    this.loadCustomerReports();
    this.loadAvailableCustomers();
  }

  closeReportsModal() {
    this.showReportsModal = false;
    this.selectedCustomerForReports = null;
    this.customerReports = [];
    this.reportsLoading = false;
  }

  loadCustomerReports() {
    if (!this.selectedCustomerForReports) return;

    this.reportsLoading = true;
    const params = {
      limit: '50',
      page: '1'
    };

    this.http.get<any>(`${this.baseUrl}/customer/${this.selectedCustomerForReports._id}`, { params })
      .subscribe({
        next: (response) => {
          this.customerReports = response.data.reports || [];
          this.reportsLoading = false;
        },
        error: (error) => {
          console.error('Error loading customer reports:', error);
          this.toastr.error('Failed to load customer reports');
          this.reportsLoading = false;
        }
      });
  }

  loadAvailableCustomers() {
    // Load all active customers for the "send to others" functionality
    this.customerService.getCustomers().subscribe({
      next: (response: any) => {
        const customers = response.customers || response;
        this.availableCustomers = customers.filter((c: Customer) => c.isActive && c._id !== this.selectedCustomerForReports?._id);
      },
      error: (error) => {
        console.error('Error loading available customers:', error);
      }
    });
  }

  viewReportDetails(report: any) {
    this.showDetailsModal = true;
    this.detailsLoading = true;
    this.reportDetails = null;

    const params: any = {};
    if (this.selectedCustomerForReports?._id) {
      params.customerId = this.selectedCustomerForReports._id;
    }

    this.http.get<any>(`${this.baseUrl}/${report.reportId}`, { params })
      .subscribe({
        next: (response) => {
          this.reportDetails = response.data;
          this.detailsLoading = false;
        },
        error: (error) => {
          console.error('Error loading report details:', error);
          this.toastr.error('Failed to load report details');
          this.detailsLoading = false;
          this.showDetailsModal = false;
        }
      });
  }

  closeDetailsModal() {
    this.showDetailsModal = false;
    this.reportDetails = null;
    this.detailsLoading = false;
  }

  openResendModal(report: any) {
    this.selectedReport = report;
    this.resendRecipients = this.selectedCustomerForReports?.email
      ? [this.selectedCustomerForReports.email]
      : [];
    this.showResendModal = true;
    this.recipientSearch = '';
    this.customEmailInput = '';
    this.loadResendProjects(report);
  }

  openSendToOthersModal(report: any) {
    this.selectedReport = report;
    this.resendRecipients = [];
    this.showResendModal = true;
    this.recipientSearch = '';
    this.customEmailInput = '';
    this.loadResendProjects(report);
  }

  loadResendProjects(report: any) {
    this.resendSubject = report?.subject || '';
    this.resendProjects = [];
    this.resendProjectsLoading = true;

    const params: any = {};
    if (this.selectedCustomerForReports?._id) {
      params.customerId = this.selectedCustomerForReports._id;
    }

    this.http.get<any>(`${this.baseUrl}/${report.reportId}`, { params })
      .subscribe({
        next: (response) => {
          const projects = response.data?.projectsFound || [];
          this.resendProjects = projects.map((p: any) => ({ ...p, include: true }));
          this.resendProjectsLoading = false;
        },
        error: (error) => {
          console.error('Error loading report matches:', error);
          this.resendProjects = [];
          this.resendProjectsLoading = false;
        }
      });
  }

  setAllMatches(include: boolean) {
    this.resendProjects.forEach(p => (p.include = include));
  }

  get filteredAvailableCustomers(): Customer[] {
    const term = this.recipientSearch.trim().toLowerCase();
    if (!term) return this.availableCustomers;
    return this.availableCustomers.filter(c =>
      c.name.toLowerCase().includes(term) || c.email.toLowerCase().includes(term)
    );
  }

  isRecipientSelected(email: string): boolean {
    return this.resendRecipients.includes(email);
  }

  toggleCustomerRecipient(email: string) {
    const idx = this.resendRecipients.indexOf(email);
    if (idx === -1) {
      this.resendRecipients = [...this.resendRecipients, email];
    } else {
      this.resendRecipients = this.resendRecipients.filter(r => r !== email);
    }
  }

  removeRecipient(email: string) {
    this.resendRecipients = this.resendRecipients.filter(r => r !== email);
  }

  addCustomEmail() {
    const email = this.customEmailInput.trim();
    if (!email) return;
    if (!this.resendRecipients.includes(email)) {
      this.resendRecipients = [...this.resendRecipients, email];
    }
    this.customEmailInput = '';
  }

  get selectedMatchCount(): number {
    return this.resendProjects.filter(p => p.include).length;
  }

  closeResendModal() {
    this.showResendModal = false;
    this.selectedReport = null;
    this.resendRecipients = [];
    this.resendLoading = false;
    this.resendSubject = '';
    this.resendProjects = [];
    this.resendProjectsLoading = false;
    this.recipientSearch = '';
    this.customEmailInput = '';
  }

  sendReport() {
    if (!this.selectedReport || this.resendRecipients.length === 0) return;

    const includedProjectIds = this.resendProjects
      .filter(p => p.include)
      .map(p => p.projectId);

    if (this.resendProjects.length > 0 && includedProjectIds.length === 0) {
      this.toastr.error('Select at least one match to send');
      return;
    }

    this.resendLoading = true;

    const body: any = {
      newRecipientEmail: this.resendRecipients.join(', '),
      customerId: this.selectedCustomerForReports?._id,
      includedProjectIds
    };

    if (this.resendSubject?.trim()) {
      body.subject = this.resendSubject.trim();
    }

    this.http.post<any>(`${this.baseUrl}/${this.selectedReport.reportId}/resend`, body)
      .subscribe({
        next: () => {
          this.toastr.success(`Report sent to ${this.resendRecipients.length} recipient${this.resendRecipients.length === 1 ? '' : 's'}!`);
          this.closeResendModal();
          this.loadCustomerReports();
        },
        error: (error) => {
          console.error('Error sending report:', error);
          this.toastr.error(error?.error?.error || 'Failed to send report');
          this.resendLoading = false;
        }
      });
  }

  // Edit Customer Methods
  openEditModal(customer: Customer) {
    this.editingCustomer = {
      _id: customer._id,
      name: customer.name,
      email: customer.email,
      phone: customer.phone || '',
      company: customer.company || '',
      filters: {
        allowedCounties: customer.filters?.allowedCounties || [],
        allowedSectors: customer.filters?.allowedSectors || []
      }
    };
    this.showEditModal = true;
  }

  closeEditModal() {
    this.showEditModal = false;
    this.editingCustomer = {
      _id: '',
      name: '',
      email: '',
      phone: '',
      company: '',
      filters: {
        allowedCounties: [],
        allowedSectors: []
      }
    };
  }

  toggleCountyFilter(county: string) {
    const index = this.editingCustomer.filters.allowedCounties.indexOf(county);
    if (index === -1) {
      this.editingCustomer.filters.allowedCounties.push(county);
    } else {
      this.editingCustomer.filters.allowedCounties.splice(index, 1);
    }
  }

  toggleSectorFilter(sector: string) {
    const index = this.editingCustomer.filters.allowedSectors.indexOf(sector);
    if (index === -1) {
      this.editingCustomer.filters.allowedSectors.push(sector);
    } else {
      this.editingCustomer.filters.allowedSectors.splice(index, 1);
    }
  }

  isCountySelected(county: string): boolean {
    return this.editingCustomer.filters.allowedCounties.includes(county);
  }

  isSectorSelected(sector: string): boolean {
    return this.editingCustomer.filters.allowedSectors.includes(sector);
  }

  isProvinceFullySelected(province: { name: string; counties: string[] }): boolean {
    return province.counties.every(county =>
      this.editingCustomer.filters.allowedCounties.includes(county)
    );
  }

  isProvincePartiallySelected(province: { name: string; counties: string[] }): boolean {
    const selectedCount = province.counties.filter(county =>
      this.editingCustomer.filters.allowedCounties.includes(county)
    ).length;
    return selectedCount > 0 && selectedCount < province.counties.length;
  }

  toggleProvinceFilter(province: { name: string; counties: string[] }) {
    if (this.isProvinceFullySelected(province)) {
      this.editingCustomer.filters.allowedCounties =
        this.editingCustomer.filters.allowedCounties.filter(
          (county: string) => !province.counties.includes(county)
        );
    } else {
      province.counties.forEach(county => {
        if (!this.editingCustomer.filters.allowedCounties.includes(county)) {
          this.editingCustomer.filters.allowedCounties.push(county);
        }
      });
    }
  }

  clearAllCountyFilters() {
    this.editingCustomer.filters.allowedCounties = [];
  }

  saveCustomerEdit() {
    if (!this.editingCustomer.name || !this.editingCustomer.email) {
      this.toastr.error('Name and email are required');
      return;
    }

    this.isUpdating = true;

    const updateData = {
      name: this.editingCustomer.name,
      email: this.editingCustomer.email,
      phone: this.editingCustomer.phone || undefined,
      company: this.editingCustomer.company || undefined,
      filters: {
        allowedCounties: this.editingCustomer.filters.allowedCounties,
        allowedSectors: this.editingCustomer.filters.allowedSectors
      }
    };

    this.customerService.updateCustomer(this.editingCustomer._id, updateData).subscribe({
      next: () => {
        this.isUpdating = false;
        this.toastr.success('Customer updated successfully');
        this.closeEditModal();
        this.loadCustomers();
      },
      error: (error) => {
        this.isUpdating = false;
        this.toastr.error('Failed to update customer');
        console.error('Error updating customer:', error);
      }
    });
  }

  openDeleteModal(customer: Customer) {
    this.customerToDelete = customer;
    this.showDeleteModal = true;
  }

  closeDeleteModal() {
    this.showDeleteModal = false;
    this.customerToDelete = null;
  }

  confirmDeleteCustomer() {
    if (!this.customerToDelete) return;

    this.isUpdating = true;

    this.customerService.deleteCustomer(this.customerToDelete._id).subscribe({
      next: () => {
        this.isUpdating = false;
        this.toastr.success(`Customer "${this.customerToDelete!.name}" and all records deleted successfully`);
        this.closeDeleteModal();
        this.loadCustomers();
      },
      error: (error) => {
        this.isUpdating = false;
        this.toastr.error('Failed to delete customer');
        console.error('Error deleting customer:', error);
      }
    });
  }
}
