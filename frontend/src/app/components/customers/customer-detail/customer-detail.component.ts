import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { FormBuilder, FormGroup, Validators, ReactiveFormsModule } from '@angular/forms';
import { CustomerService, Customer } from '../../../services/customer.service';
import { ToastrService } from 'ngx-toastr';

@Component({
  selector: 'app-customer-detail',
  standalone: true,
  imports: [CommonModule, RouterModule, ReactiveFormsModule],
  template: `
    <div class="detail-container" *ngIf="customer">
      <div class="detail-header">
        <div class="header-info">
          <div class="breadcrumb">
            <a routerLink="/customers" class="breadcrumb-link">Customers</a>
            <span class="breadcrumb-separator">›</span>
            <span class="breadcrumb-current">{{ customer.name }}</span>
          </div>
          <h1>{{ customer.name }}</h1>
          <div class="header-meta">
            <span class="customer-email">{{ customer.email }}</span>
            <span class="status-badge" [class]="customer.isActive ? 'status-active' : 'status-inactive'">
              {{ customer.isActive ? 'Active' : 'Inactive' }}
            </span>
          </div>
        </div>
        <div class="header-actions">
          <button
            *ngIf="!isEditing"
            (click)="startEditing()"
            class="btn btn-secondary"
            [disabled]="isUpdating"
          >
            <span>✏️</span> Edit
          </button>
          <button
            *ngIf="isEditing"
            (click)="saveChanges()"
            class="btn btn-primary"
            [disabled]="!editForm.valid || isUpdating"
          >
            <span *ngIf="isUpdating" class="spinner"></span>
            💾 Save
          </button>
          <button
            *ngIf="isEditing"
            (click)="cancelEditing()"
            class="btn btn-secondary"
            [disabled]="isUpdating"
          >
            ❌ Cancel
          </button>
          <button
            *ngIf="!isEditing"
            (click)="toggleCustomerStatus()"
            class="btn"
            [class]="customer.isActive ? 'btn-warning' : 'btn-success'"
            [disabled]="isUpdating"
          >
            <span *ngIf="isUpdating" class="spinner"></span>
            {{ customer.isActive ? 'Deactivate' : 'Activate' }}
          </button>
        </div>
      </div>

      <div class="detail-content">
        <div class="detail-section">
          <h2>Customer Information</h2>

          <!-- View Mode -->
          <div class="info-grid" *ngIf="!isEditing">
            <div class="info-item">
              <label>Name</label>
              <span>{{ customer.name }}</span>
            </div>
            <div class="info-item">
              <label>Email</label>
              <span>{{ customer.email }}</span>
            </div>
            <div class="info-item" *ngIf="customer.company">
              <label>Company</label>
              <span>{{ customer.company }}</span>
            </div>
            <div class="info-item" *ngIf="customer.phone">
              <label>Phone</label>
              <span>{{ customer.phone }}</span>
            </div>
          </div>

          <!-- Edit Mode -->
          <form [formGroup]="editForm" *ngIf="isEditing" class="edit-form">
            <div class="form-group">
              <label for="name">Name *</label>
              <input
                id="name"
                type="text"
                formControlName="name"
                class="form-control"
                [class.is-invalid]="editForm.get('name')?.invalid && editForm.get('name')?.touched"
              >
              <div class="invalid-feedback" *ngIf="editForm.get('name')?.invalid && editForm.get('name')?.touched">
                <div *ngIf="editForm.get('name')?.errors?.['required']">Name is required</div>
                <div *ngIf="editForm.get('name')?.errors?.['minlength']">Name must be at least 2 characters</div>
                <div *ngIf="editForm.get('name')?.errors?.['maxlength']">Name cannot exceed 100 characters</div>
              </div>
            </div>

            <div class="form-group">
              <label for="email">Email *</label>
              <input
                id="email"
                type="email"
                formControlName="email"
                class="form-control"
                [class.is-invalid]="editForm.get('email')?.invalid && editForm.get('email')?.touched"
                readonly
                title="Email cannot be changed"
              >
              <small class="form-text text-muted">Email address cannot be modified</small>
            </div>

            <div class="form-group">
              <label for="company">Company</label>
              <input
                id="company"
                type="text"
                formControlName="company"
                class="form-control"
                [class.is-invalid]="editForm.get('company')?.invalid && editForm.get('company')?.touched"
              >
              <div class="invalid-feedback" *ngIf="editForm.get('company')?.invalid && editForm.get('company')?.touched">
                <div *ngIf="editForm.get('company')?.errors?.['maxlength']">Company name cannot exceed 200 characters</div>
              </div>
            </div>

            <div class="form-group">
              <label for="phone">Phone</label>
              <input
                id="phone"
                type="tel"
                formControlName="phone"
                class="form-control"
                [class.is-invalid]="editForm.get('phone')?.invalid && editForm.get('phone')?.touched"
              >
              <div class="invalid-feedback" *ngIf="editForm.get('phone')?.invalid && editForm.get('phone')?.touched">
                <div *ngIf="editForm.get('phone')?.errors?.['maxlength']">Phone number cannot exceed 20 characters</div>
              </div>
            </div>
          </form>
        </div>

        <div class="detail-section">
          <h2>Subscription Information</h2>
          <div class="info-grid">
            <div class="info-item">
              <label>Email Count</label>
              <span>{{ customer.email }}</span>
            </div>
            <div class="info-item" *ngIf="customer.phone">
              <label>Phone</label>
              <span>{{ customer.phone }}</span>
            </div>
            <div class="info-item" *ngIf="customer.company">
              <label>Company</label>
              <span>{{ customer.company }}</span>
            </div>
            <div class="info-item">
              <label>Status</label>
              <span class="status-badge" [class]="customer.isActive ? 'status-active' : 'status-inactive'">
                {{ customer.isActive ? 'Active' : 'Inactive' }}
              </span>
            </div>
            <div class="info-item">
              <label>Created</label>
              <span>{{ formatDate(customer.createdAt) }}</span>
            </div>
            <div class="info-item" *ngIf="customer.lastEmailSent">
              <label>Last Email Sent</label>
              <span>{{ formatDate(customer.lastEmailSent) }}</span>
            </div>
            <div class="info-item">
              <label>Total Emails Sent</label>
              <span class="email-count">{{ customer.emailCount || 0 }}</span>
            </div>
            <div class="info-item">
              <label>Last Updated</label>
              <span>{{ formatDate(customer.updatedAt) }}</span>
            </div>
          </div>
        </div>

        <div class="detail-section">
          <h2>Report Types</h2>
          <div class="report-types-content" *ngIf="customer.reportTypes && customer.reportTypes.length > 0; else noReportTypes">
            <div class="report-type-list">
              <div class="report-type-item" *ngFor="let reportType of customer.reportTypes">
                <span class="report-type-name">{{ formatReportType(reportType) }}</span>
                <button
                  class="remove-report-type"
                  (click)="removeReportType(reportType)"
                  [disabled]="isUpdating"
                  title="Remove report type"
                >
                  ×
                </button>
              </div>
            </div>
          </div>

          <ng-template #noReportTypes>
            <div class="no-subscriptions">
              <p>This customer has no active subscriptions.</p>
            </div>
          </ng-template>
        </div>
      </div>
    </div>

    <div class="loading" *ngIf="!customer && !error">
      <div class="spinner large"></div>
      <p>Loading customer details...</p>
    </div>

    <div class="error" *ngIf="error">
      <div class="error-icon">❌</div>
      <h2>Customer Not Found</h2>
      <p>{{ error }}</p>
      <a routerLink="/customers" class="btn btn-primary">Back to Customers</a>
    </div>
  `,
  styles: [`
    .detail-container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 2rem;
    }

    .detail-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 2rem;
      gap: 2rem;
    }

    .header-info {
      flex: 1;
    }

    .breadcrumb {
      margin-bottom: 0.5rem;
      font-size: 0.9rem;
    }

    .breadcrumb-link {
      color: #667eea;
      text-decoration: none;
    }

    .breadcrumb-link:hover {
      text-decoration: underline;
    }

    .breadcrumb-separator {
      margin: 0 0.5rem;
      color: #666;
    }

    .breadcrumb-current {
      color: #666;
    }

    .detail-header h1 {
      margin: 0 0 1rem 0;
      color: #333;
      font-size: 2rem;
    }

    .header-meta {
      display: flex;
      gap: 1rem;
      align-items: center;
    }

    .customer-email {
      color: #666;
      font-size: 1rem;
    }

    .status-badge {
      padding: 0.375rem 0.75rem;
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

    .header-actions {
      display: flex;
      gap: 1rem;
    }

    .btn {
      border: none;
      border-radius: 4px;
      padding: 0.75rem 1.5rem;
      font-size: 0.9rem;
      cursor: pointer;
      transition: all 0.3s;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      text-decoration: none;
      font-weight: 500;
    }

    .btn-primary {
      background: #667eea;
      color: white;
    }

    .btn-primary:hover:not(:disabled) {
      background: #5a6fd8;
    }

    .btn-success {
      background: #28a745;
      color: white;
    }

    .btn-success:hover:not(:disabled) {
      background: #218838;
    }

    .btn-warning {
      background: #ffc107;
      color: #212529;
    }

    .btn-warning:hover:not(:disabled) {
      background: #e0a800;
    }

    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .spinner {
      width: 16px;
      height: 16px;
      border: 2px solid transparent;
      border-top: 2px solid currentColor;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }

    .spinner.large {
      width: 40px;
      height: 40px;
      margin: 0 auto 1rem;
    }

    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }

    .detail-content {
      display: flex;
      flex-direction: column;
      gap: 2rem;
    }

    .detail-section {
      background: white;
      padding: 2rem;
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }

    .detail-section h2 {
      margin: 0 0 1.5rem 0;
      color: #333;
      font-size: 1.5rem;
      border-bottom: 2px solid #f0f4ff;
      padding-bottom: 0.5rem;
    }

    .info-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 1.5rem;
    }

    .info-item {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .info-item label {
      font-weight: 500;
      color: #666;
      font-size: 0.9rem;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .info-item span {
      color: #333;
      font-size: 1rem;
    }

    .subscriptions-content {
      margin-top: 1rem;
    }

    .subscription-list {
      display: flex;
      flex-wrap: wrap;
      gap: 1rem;
    }

    .subscription-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      background: #e7f3ff;
      color: #0366d6;
      padding: 0.5rem 0.75rem;
      border-radius: 6px;
      font-weight: 500;
    }

    .subscription-name {
      flex: 1;
    }

    .remove-subscription {
      background: #dc3545;
      color: white;
      border: none;
      border-radius: 50%;
      width: 20px;
      height: 20px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1rem;
      line-height: 1;
      transition: background-color 0.3s;
    }

    .remove-subscription:hover:not(:disabled) {
      background: #c82333;
    }

    .remove-subscription:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .no-subscriptions {
      text-align: center;
      padding: 2rem;
      color: #666;
    }

    .loading,
    .error {
      text-align: center;
      padding: 3rem;
      color: #666;
    }

    .error-icon {
      font-size: 3rem;
      margin-bottom: 1rem;
    }

    .error h2 {
      margin: 0 0 1rem 0;
      color: #333;
    }

    .edit-form {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1.5rem;
      margin: 1rem 0;
    }

    .form-group {
      display: flex;
      flex-direction: column;
    }

    .form-group label {
      font-weight: 600;
      margin-bottom: 0.5rem;
      color: #374151;
    }

    .form-control {
      padding: 0.75rem;
      border: 2px solid #e5e7eb;
      border-radius: 8px;
      font-size: 1rem;
      transition: border-color 0.3s, box-shadow 0.3s;
    }

    .form-control:focus {
      outline: none;
      border-color: #667eea;
      box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
    }

    .form-control:readonly {
      background-color: #f9fafb;
      color: #6b7280;
      cursor: not-allowed;
    }

    .form-control.is-invalid {
      border-color: #ef4444;
      box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.1);
    }

    .invalid-feedback {
      color: #ef4444;
      font-size: 0.875rem;
      margin-top: 0.25rem;
    }

    .form-text {
      font-size: 0.875rem;
      color: #6b7280;
      margin-top: 0.25rem;
    }

    .header-actions {
      display: flex;
      gap: 0.5rem;
    }

    .error p {
      margin: 0 0 2rem 0;
      line-height: 1.6;
    }

    @media (max-width: 768px) {
      .detail-container {
        padding: 1rem;
      }

      .detail-header {
        flex-direction: column;
        gap: 1rem;
      }

      .header-actions {
        width: 100%;
        justify-content: center;
        flex-wrap: wrap;
      }

      .info-grid {
        grid-template-columns: 1fr;
      }

      .edit-form {
        grid-template-columns: 1fr;
        gap: 1rem;
      }

      .subscription-list {
        flex-direction: column;
      }
    }
  `]
})
export class CustomerDetailComponent implements OnInit {
  customer: Customer | null = null;
  error: string | null = null;
  isUpdating = false;
  isEditing = false;
  customerId: string | null = null;
  editForm: FormGroup;
  originalCustomerData: Partial<Customer> = {};

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private customerService: CustomerService,
    private toastr: ToastrService,
    private formBuilder: FormBuilder
  ) {
    this.editForm = this.formBuilder.group({
      name: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(100)]],
      email: [{value: '', disabled: true}, [Validators.required, Validators.email]],
      company: ['', [Validators.maxLength(200)]],
      phone: ['', [Validators.maxLength(20)]]
    });
  }

  ngOnInit() {
    this.customerId = this.route.snapshot.paramMap.get('id');
    if (this.customerId) {
      this.loadCustomer(this.customerId);
    } else {
      this.error = 'No customer ID provided';
    }
  }

  loadCustomer(id: string) {
    this.customerService.getCustomer(id).subscribe({
      next: (customer) => {
        this.customer = customer;
        this.error = null;
        this.initializeForm();
      },
      error: (error) => {
        this.error = error.error?.error || 'Failed to load customer';
        console.error('Error loading customer:', error);
      }
    });
  }

  initializeForm() {
    if (this.customer) {
      this.editForm.patchValue({
        name: this.customer.name,
        email: this.customer.email,
        company: this.customer.company || '',
        phone: this.customer.phone || ''
      });

      // Store original data for cancellation
      this.originalCustomerData = {
        name: this.customer.name,
        company: this.customer.company,
        phone: this.customer.phone
      };
    }
  }

  startEditing() {
    this.isEditing = true;
    this.initializeForm();
  }

  cancelEditing() {
    this.isEditing = false;
    this.initializeForm(); // Reset form to original values
    this.editForm.markAsUntouched();
  }

  saveChanges() {
    if (!this.customerId || !this.customer || !this.editForm.valid) return;

    this.isUpdating = true;
    const formData = this.editForm.value;

    // Only send changed fields
    const updateData: any = {};
    if (formData.name !== this.originalCustomerData.name) {
      updateData.name = formData.name;
    }
    if (formData.company !== this.originalCustomerData.company) {
      updateData.company = formData.company || undefined;
    }
    if (formData.phone !== this.originalCustomerData.phone) {
      updateData.phone = formData.phone || undefined;
    }

    // If no changes, just exit edit mode
    if (Object.keys(updateData).length === 0) {
      this.isEditing = false;
      this.isUpdating = false;
      this.toastr.info('No changes to save');
      return;
    }

    this.customerService.updateCustomer(this.customerId, updateData).subscribe({
      next: (updatedCustomer) => {
        this.isUpdating = false;
        this.isEditing = false;
        this.customer = updatedCustomer;
        this.originalCustomerData = {
          name: updatedCustomer.name,
          company: updatedCustomer.company,
          phone: updatedCustomer.phone
        };
        this.toastr.success('Customer updated successfully');
      },
      error: (error) => {
        this.isUpdating = false;
        this.toastr.error('Failed to update customer');
        console.error('Error updating customer:', error);
      }
    });
  }

  toggleCustomerStatus() {
    if (!this.customerId || !this.customer) return;

    this.isUpdating = true;
    const newStatus = !this.customer.isActive;

    this.customerService.updateCustomer(this.customerId, { isActive: newStatus }).subscribe({
      next: (updatedCustomer) => {
        this.isUpdating = false;
        this.customer = updatedCustomer;
        this.toastr.success(`Customer ${newStatus ? 'activated' : 'deactivated'} successfully`);
      },
      error: (error) => {
        this.isUpdating = false;
        this.toastr.error('Failed to update customer status');
        console.error('Error updating customer:', error);
      }
    });
  }

  removeReportType(reportType: string) {
    if (!this.customerId || !this.customer) return;

    this.isUpdating = true;
    // Remove the report type from the array and update
    const updatedReportTypes = this.customer.reportTypes.filter(type => type !== reportType);
    this.customerService.updateCustomer(this.customerId, { reportTypes: updatedReportTypes }).subscribe({
      next: (updatedCustomer) => {
        this.isUpdating = false;
        this.customer = updatedCustomer;
        this.toastr.success('Report type removed successfully');
      },
      error: (error) => {
        this.isUpdating = false;
        this.toastr.error('Failed to remove report type');
        console.error('Error removing report type:', error);
      }
    });
  }

  formatReportType(reportType: string): string {
    return reportType.charAt(0).toUpperCase() + reportType.slice(1);
  }

  formatDate(date: Date | string): string {
    const d = new Date(date);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}
