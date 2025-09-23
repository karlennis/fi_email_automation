import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { CustomerService, Customer, CustomerHistory } from '../../../services/customer.service';
import { ToastrService } from 'ngx-toastr';

@Component({
  selector: 'app-customer-list',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule],
  styleUrls: ['./customer-list.component.css'],
  template: `
    <div class="customers-container">
      <div class="page-header">
        <h1>Customer Management</h1>
        <div class="header-actions">
          <button class="btn btn-primary" (click)="showAddCustomer = true">
            <span class="btn-icon">➕</span>
            Add Customer
          </button>
        </div>
      </div>

      <div class="search-filters">
        <div class="search-bar">
          <input
            type="text"
            placeholder="Search customers by name, email, or company..."
            [(ngModel)]="searchQuery"
            (input)="onSearchChange()"
            class="search-input"
          >
        </div>
        <div class="filters">
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
      </div>

      <div class="customers-section">
        <div class="loading" *ngIf="isLoading">
          <div class="spinner large"></div>
          <p>Loading customers...</p>
        </div>

        <div class="customers-list" *ngIf="!isLoading && customers.length > 0">
          <div class="customer-card" *ngFor="let customer of customers">
            <div class="card-header">
              <div class="customer-info">
                <h3>{{ customer.name }}</h3>
                <span class="customer-email">{{ customer.email }}</span>
              </div>
              <div class="customer-status">
                <span class="status-badge" [class]="customer.isActive ? 'status-active' : 'status-inactive'">
                  {{ customer.isActive ? 'Active' : 'Inactive' }}
                </span>
              </div>
            </div>

            <div class="card-body">
              <div class="customer-details">
                <div class="detail-item" *ngIf="customer.phone">
                  <span class="detail-label">Phone:</span>
                  <span class="detail-value">{{ customer.phone }}</span>
                </div>
                <div class="detail-item" *ngIf="customer.company">
                  <span class="detail-label">Company:</span>
                  <span class="detail-value">{{ customer.company }}</span>
                </div>
              </div>

              <div class="report-types" *ngIf="customer.reportTypes && customer.reportTypes.length > 0">
                <h4>Report Types ({{ customer.reportTypes.length }})</h4>
                <div class="report-type-list">
                  <span class="report-type-tag" *ngFor="let type of customer.reportTypes">
                    {{ formatReportType(type) }}
                  </span>
                </div>
              </div>

              <div class="customer-stats" *ngIf="customer.emailCount > 0">
                <div class="stat-item">
                  <span class="stat-label">FI Reports Sent:</span>
                  <span class="stat-value">{{ customer.emailCount }}</span>
                </div>
                <div class="stat-item" *ngIf="customer.lastEmailSent">
                  <span class="stat-label">Last Report:</span>
                  <span class="stat-value">{{ formatDate(customer.lastEmailSent) }}</span>
                </div>
              </div>
            </div>

            <div class="card-footer">
              <div class="customer-dates">
                <span class="created-date">Created: {{ formatDate(customer.createdAt) }}</span>
              </div>
              <div class="card-actions">
                <button
                  (click)="viewCustomerHistory(customer._id)"
                  class="btn btn-sm btn-info"
                  [disabled]="isLoading"
                >
                  📋 FI History
                </button>
                <button
                  (click)="quickSelectCustomer(customer)"
                  class="btn btn-sm btn-success"
                  [disabled]="!customer.isActive"
                  title="Quick select for new FI report"
                >
                  ✉️ Quick Select
                </button>
                <button
                  (click)="toggleCustomerStatus(customer._id)"
                  class="btn btn-sm"
                  [class]="customer.isActive ? 'btn-warning' : 'btn-secondary'"
                  [disabled]="isUpdating"
                >
                  {{ customer.isActive ? 'Deactivate' : 'Activate' }}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="no-customers" *ngIf="!isLoading && customers.length === 0">
          <div class="no-customers-content">
            <div class="no-customers-icon">👥</div>
            <h3>No Customers Found</h3>
            <p>Start by adding customers to manage FI email notifications.</p>
            <button class="btn btn-primary" (click)="showAddCustomer = true">Add First Customer</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Customer History Modal -->
    <div class="modal" *ngIf="showHistoryModal" (click)="closeHistoryModal()">
      <div class="modal-content large" (click)="$event.stopPropagation()">
        <div class="modal-header">
          <h2>📋 FI Report History</h2>
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
          <h2>✉️ Customer Selected</h2>
          <span class="close" (click)="closeQuickSelectModal()">&times;</span>
        </div>
        <div class="modal-body">
          <div class="success-message">
            <div class="success-icon">✅</div>
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

    <!-- Add Customer Modal (simplified) -->
    <div class="modal" *ngIf="showAddCustomer" (click)="showAddCustomer = false">
      <div class="modal-content" (click)="$event.stopPropagation()">
        <div class="modal-header">
          <h2>Add New Customer</h2>
          <button class="close-btn" (click)="showAddCustomer = false">×</button>
        </div>
        <div class="modal-body">
          <p>Customer management functionality will be implemented here.</p>
          <p>For now, customers can be managed through the backend API directly.</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" (click)="showAddCustomer = false">Close</button>
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
      color: #333;
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
      background: #667eea;
      color: white;
    }

    .btn-primary:hover {
      background: #5a6fd8;
    }

    .btn-secondary {
      background: #6c757d;
      color: white;
    }

    .btn-success {
      background: #28a745;
      color: white;
    }

    .btn-warning {
      background: #ffc107;
      color: #212529;
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
      color: #666;
    }

    .spinner {
      width: 24px;
      height: 24px;
      border: 2px solid #e9ecef;
      border-top: 2px solid #667eea;
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
      background: white;
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      overflow: hidden;
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1.5rem;
      background: #f8f9fa;
      border-bottom: 1px solid #e9ecef;
    }

    .customer-info h3 {
      margin: 0 0 0.25rem 0;
      color: #333;
      font-size: 1.3rem;
    }

    .customer-email {
      color: #666;
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
      background: #d4edda;
      color: #155724;
    }

    .status-inactive {
      background: #f8d7da;
      color: #721c24;
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
      color: #666;
      min-width: 60px;
    }

    .detail-value {
      color: #333;
    }

    .subscriptions h4 {
      margin: 0 0 0.75rem 0;
      color: #333;
      font-size: 1rem;
    }

    .subscription-list {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }

    .subscription-tag {
      background: #e7f3ff;
      color: #0366d6;
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
      background: #f8f9fa;
      border-top: 1px solid #e9ecef;
    }

    .customer-dates {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .created-date,
    .notification-date {
      font-size: 0.8rem;
      color: #666;
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
      color: #333;
    }

    .no-customers p {
      margin: 0 0 2rem 0;
      color: #666;
      line-height: 1.6;
    }

    /* Modal styles */
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
      padding: 1.5rem;
      border-bottom: 1px solid #e9ecef;
    }

    .modal-header h2 {
      margin: 0;
      color: #333;
    }

    .close-btn {
      background: none;
      border: none;
      font-size: 1.5rem;
      cursor: pointer;
      color: #666;
      padding: 0;
      width: 30px;
      height: 30px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .close-btn:hover {
      color: #333;
    }

    .modal-body {
      padding: 1.5rem;
    }

    .modal-footer {
      padding: 1rem 1.5rem;
      border-top: 1px solid #e9ecef;
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
  `]
})
export class CustomerListComponent implements OnInit {
  customers: Customer[] = [];
  isLoading = false;
  isUpdating = false;
  showAddCustomer = false;

  // Search and filtering
  searchQuery = '';
  selectedReportType = '';
  selectedStatus = '';
  searchTimeout: any;

  // Customer history modal
  showHistoryModal = false;
  selectedCustomerHistory: CustomerHistory | null = null;
  historyLoading = false;

  // Quick select modal
  showQuickSelectModal = false;
  quickSelectedCustomer: Customer | null = null;

  constructor(
    private customerService: CustomerService,
    private toastr: ToastrService
  ) {}

  ngOnInit() {
    this.loadCustomers();
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

  formatDate(date: Date | string): string {
    if (!date) return 'N/A';
    const d = new Date(date);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  formatReportType(reportType: string): string {
    return reportType.charAt(0).toUpperCase() + reportType.slice(1);
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
}
