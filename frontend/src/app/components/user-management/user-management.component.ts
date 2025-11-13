import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { UserService, User, CreateUserRequest, UpdateUserRequest } from '../../services/user.service';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-user-management',
  standalone: true,
  imports: [CommonModule, FormsModule, ReactiveFormsModule, RouterModule],
  template: `
    <div class="user-management">
      <div class="page-header">
        <h1>User Management</h1>
        <p>Manage system users and permissions</p>
      </div>

      <!-- Filters and Actions -->
      <div class="controls">
        <div class="filters">
          <input
            type="text"
            placeholder="Search users..."
            [(ngModel)]="searchTerm"
            (keyup.enter)="loadUsers()"
            class="search-input"
          >

          <select [(ngModel)]="roleFilter" (change)="loadUsers()" class="filter-select">
            <option value="">All Roles</option>
            <option value="admin">Admin</option>
            <option value="operator">Operator</option>
          </select>

          <select [(ngModel)]="statusFilter" (change)="loadUsers()" class="filter-select">
            <option value="">All Status</option>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </select>
        </div>

        <div class="actions" *ngIf="canManageUsers">
          <button
            class="btn-primary"
            (click)="openCreateUserModal()"
          >
            <span class="icon">👤</span>
            Add User
          </button>
        </div>
      </div>

      <!-- Users Table -->
      <div class="table-container">
        <table class="users-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Department</th>
              <th>Status</th>
              <th>Last Login</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr *ngFor="let user of users" [class.inactive]="!user.isActive">
              <td>
                <div class="user-info">
                  <div class="user-avatar">
                    {{ user.name.charAt(0).toUpperCase() }}
                  </div>
                  <div>
                    <div class="user-name">{{ user.name }}</div>
                    <div class="user-title" *ngIf="user.jobTitle">{{ user.jobTitle }}</div>
                  </div>
                </div>
              </td>
              <td>{{ user.email }}</td>
              <td>
                <span class="role-badge" [class]="user.role">
                  {{ user.role | titlecase }}
                </span>
              </td>
              <td>{{ user.department || 'N/A' }}</td>
              <td>
                <span class="status-badge" [class.active]="user.isActive" [class.inactive]="!user.isActive">
                  {{ user.isActive ? 'Active' : 'Inactive' }}
                </span>
              </td>
              <td>{{ formatDate(user.lastLogin) }}</td>
              <td>
                <div class="action-buttons" *ngIf="canManageUsers || user.id === currentUserId">
                  <button
                    class="btn-secondary btn-sm"
                    (click)="openEditUserModal(user)"
                    *ngIf="canManageUsers"
                  >
                    Edit
                  </button>

                  <button
                    class="btn-warning btn-sm"
                    (click)="toggleUserStatus(user)"
                    *ngIf="canManageUsers && user.id !== currentUserId"
                  >
                    {{ user.isActive ? 'Deactivate' : 'Activate' }}
                  </button>

                  <button
                    class="btn-secondary btn-sm"
                    (click)="openChangePasswordModal(user)"
                    *ngIf="user.id === currentUserId"
                  >
                    Change Password
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Pagination -->
      <div class="pagination" *ngIf="pagination">
        <button
          class="btn-secondary"
          (click)="changePage(pagination.currentPage - 1)"
          [disabled]="!pagination.hasPrevPage"
        >
          Previous
        </button>

        <span class="page-info">
          Page {{ pagination.currentPage }} of {{ pagination.totalPages }}
          ({{ pagination.totalUsers }} total users)
        </span>

        <button
          class="btn-secondary"
          (click)="changePage(pagination.currentPage + 1)"
          [disabled]="!pagination.hasNextPage"
        >
          Next
        </button>
      </div>

      <!-- Create/Edit User Modal -->
      <div class="modal" *ngIf="showUserModal" (click)="closeUserModal()">
        <div class="modal-content" (click)="$event.stopPropagation()">
          <div class="modal-header">
            <h3>{{ editingUser ? 'Edit User' : 'Create User' }}</h3>
            <button class="close-btn" (click)="closeUserModal()">&times;</button>
          </div>

          <form [formGroup]="userForm" (ngSubmit)="saveUser()">
            <div class="form-group">
              <label for="name">Full Name *</label>
              <input
                id="name"
                type="text"
                formControlName="name"
                class="form-control"
                [class.error]="userForm.get('name')?.invalid && userForm.get('name')?.touched"
              >
              <div class="error-message" *ngIf="userForm.get('name')?.invalid && userForm.get('name')?.touched">
                Name is required
              </div>
            </div>

            <div class="form-group" *ngIf="!editingUser">
              <label for="email">Email Address *</label>
              <input
                id="email"
                type="email"
                formControlName="email"
                class="form-control"
                placeholder="user&#64;buildinginfo.com"
                [class.error]="userForm.get('email')?.invalid && userForm.get('email')?.touched"
              >
              <div class="error-message" *ngIf="userForm.get('email')?.invalid && userForm.get('email')?.touched">
                Valid &#64;buildinginfo.com email is required
              </div>
            </div>

            <div class="form-group" *ngIf="!editingUser">
              <label for="password">Password *</label>
              <input
                id="password"
                type="password"
                formControlName="password"
                class="form-control"
                [class.error]="userForm.get('password')?.invalid && userForm.get('password')?.touched"
              >
              <div class="error-message" *ngIf="userForm.get('password')?.invalid && userForm.get('password')?.touched">
                Password must be at least 8 characters with uppercase, lowercase, number, and special character
              </div>
            </div>

            <div class="form-group">
              <label for="role">Role *</label>
              <select
                id="role"
                formControlName="role"
                class="form-control"
                [disabled]="!!(editingUser && editingUser.id === currentUserId)"
              >
                <option value="operator">Operator</option>
                <option value="admin">Admin</option>
              </select>
            </div>

            <div class="form-group">
              <label for="department">Department</label>
              <input
                id="department"
                type="text"
                formControlName="department"
                class="form-control"
              >
            </div>

            <div class="form-group">
              <label for="jobTitle">Job Title</label>
              <input
                id="jobTitle"
                type="text"
                formControlName="jobTitle"
                class="form-control"
              >
            </div>

            <div class="form-group" *ngIf="editingUser">
              <label class="checkbox-label">
                <input
                  type="checkbox"
                  formControlName="isActive"
                  [disabled]="!!(editingUser && editingUser.id === currentUserId)"
                >
                Active User
              </label>
            </div>

            <div class="modal-actions">
              <button type="button" class="btn-secondary" (click)="closeUserModal()">
                Cancel
              </button>
              <button
                type="submit"
                class="btn-primary"
                [disabled]="userForm.invalid || isLoading"
              >
                {{ isLoading ? 'Saving...' : (editingUser ? 'Update' : 'Create') }}
              </button>
            </div>
          </form>
        </div>
      </div>

      <!-- Change Password Modal -->
      <div class="modal" *ngIf="showPasswordModal" (click)="closePasswordModal()">
        <div class="modal-content" (click)="$event.stopPropagation()">
          <div class="modal-header">
            <h3>Change Password</h3>
            <button class="close-btn" (click)="closePasswordModal()">&times;</button>
          </div>

          <form [formGroup]="passwordForm" (ngSubmit)="changePassword()">
            <div class="form-group">
              <label for="currentPassword">Current Password *</label>
              <input
                id="currentPassword"
                type="password"
                formControlName="currentPassword"
                class="form-control"
              >
            </div>

            <div class="form-group">
              <label for="newPassword">New Password *</label>
              <input
                id="newPassword"
                type="password"
                formControlName="newPassword"
                class="form-control"
              >
              <small class="help-text">
                Must be at least 8 characters with uppercase, lowercase, number, and special character
              </small>
            </div>

            <div class="form-group">
              <label for="confirmPassword">Confirm New Password *</label>
              <input
                id="confirmPassword"
                type="password"
                formControlName="confirmPassword"
                class="form-control"
              >
            </div>

            <div class="modal-actions">
              <button type="button" class="btn-secondary" (click)="closePasswordModal()">
                Cancel
              </button>
              <button
                type="submit"
                class="btn-primary"
                [disabled]="passwordForm.invalid || isLoading"
              >
                {{ isLoading ? 'Changing...' : 'Change Password' }}
              </button>
            </div>
          </form>
        </div>
      </div>

      <!-- Loading Overlay -->
      <div class="loading-overlay" *ngIf="isLoading">
        <div class="spinner"></div>
      </div>
    </div>
  `,
  styles: [`
    .user-management {
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
    }

    .page-header {
      margin-bottom: 30px;
    }

    .page-header h1 {
      color: #2c3e50;
      margin-bottom: 10px;
    }

    .page-header p {
      color: #7f8c8d;
      margin: 0;
    }

    .controls {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      flex-wrap: wrap;
      gap: 15px;
    }

    .filters {
      display: flex;
      gap: 15px;
      flex-wrap: wrap;
    }

    .search-input,
    .filter-select {
      padding: 10px;
      border: 2px solid #e3e6ea;
      border-radius: 8px;
      font-size: 14px;
      transition: border-color 0.3s ease;
    }

    .search-input:focus,
    .filter-select:focus {
      outline: none;
      border-color: #4f46e5;
    }

    .search-input {
      width: 250px;
    }

    .filter-select {
      width: 120px;
    }

    .table-container {
      background: white;
      border-radius: 12px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.07);
      overflow: hidden;
      margin-bottom: 20px;
    }

    .users-table {
      width: 100%;
      border-collapse: collapse;
    }

    .users-table th {
      background: #f8fafc;
      padding: 15px;
      text-align: left;
      font-weight: 600;
      color: #374151;
      border-bottom: 2px solid #e5e7eb;
    }

    .users-table td {
      padding: 15px;
      border-bottom: 1px solid #e5e7eb;
      vertical-align: middle;
    }

    .users-table tr:hover {
      background-color: #f9fafb;
    }

    .users-table tr.inactive {
      opacity: 0.6;
    }

    .user-info {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .user-avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: bold;
      font-size: 16px;
    }

    .user-name {
      font-weight: 500;
      color: #374151;
    }

    .user-title {
      font-size: 12px;
      color: #9ca3af;
    }

    .role-badge {
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 500;
      text-transform: uppercase;
    }

    .role-badge.admin {
      background: #fef3c7;
      color: #92400e;
    }

    .role-badge.operator {
      background: #dbeafe;
      color: #1e40af;
    }

    .status-badge {
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 500;
    }

    .status-badge.active {
      background: #d1fae5;
      color: #065f46;
    }

    .status-badge.inactive {
      background: #fee2e2;
      color: #991b1b;
    }

    .action-buttons {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .btn-sm {
      padding: 6px 12px;
      font-size: 12px;
    }

    .pagination {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 20px;
      margin-top: 20px;
    }

    .page-info {
      color: #6b7280;
      font-size: 14px;
    }

    /* Modal Styles */
    .modal {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .modal-content {
      background: white;
      border-radius: 12px;
      width: 90%;
      max-width: 500px;
      max-height: 90vh;
      overflow-y: auto;
    }

    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 20px 20px 0;
      margin-bottom: 20px;
    }

    .modal-header h3 {
      margin: 0;
      color: #374151;
    }

    .close-btn {
      background: none;
      border: none;
      font-size: 24px;
      cursor: pointer;
      color: #9ca3af;
      padding: 0;
      width: 30px;
      height: 30px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .close-btn:hover {
      background: #f3f4f6;
      color: #374151;
    }

    .form-group {
      margin-bottom: 20px;
      padding: 0 20px;
    }

    .form-group label {
      display: block;
      margin-bottom: 8px;
      font-weight: 500;
      color: #374151;
    }

    .form-control {
      width: 100%;
      padding: 10px 12px;
      border: 2px solid #e5e7eb;
      border-radius: 8px;
      font-size: 14px;
      transition: border-color 0.3s ease;
      box-sizing: border-box;
    }

    .form-control:focus {
      outline: none;
      border-color: #4f46e5;
    }

    .form-control.error {
      border-color: #ef4444;
    }

    .error-message {
      color: #ef4444;
      font-size: 12px;
      margin-top: 5px;
    }

    .help-text {
      color: #6b7280;
      font-size: 12px;
      margin-top: 5px;
      display: block;
    }

    .checkbox-label {
      display: flex !important;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      margin-bottom: 0 !important;
    }

    .checkbox-label input[type="checkbox"] {
      width: auto;
      margin: 0;
    }

    .modal-actions {
      padding: 20px;
      border-top: 1px solid #e5e7eb;
      display: flex;
      justify-content: flex-end;
      gap: 12px;
    }

    /* Button Styles */
    .btn-primary,
    .btn-secondary,
    .btn-warning {
      padding: 10px 20px;
      border: none;
      border-radius: 8px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.3s ease;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
    }

    .btn-primary {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }

    .btn-primary:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow: 0 10px 20px rgba(102, 126, 234, 0.4);
    }

    .btn-secondary {
      background: #f3f4f6;
      color: #374151;
      border: 2px solid #e5e7eb;
    }

    .btn-secondary:hover:not(:disabled) {
      background: #e5e7eb;
    }

    .btn-warning {
      background: #fbbf24;
      color: #92400e;
    }

    .btn-warning:hover:not(:disabled) {
      background: #f59e0b;
    }

    .btn-primary:disabled,
    .btn-secondary:disabled,
    .btn-warning:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none;
    }

    .icon {
      font-size: 16px;
    }

    /* Loading Styles */
    .loading-overlay {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(255, 255, 255, 0.8);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 9999;
    }

    .spinner {
      width: 40px;
      height: 40px;
      border: 4px solid #e5e7eb;
      border-top: 4px solid #4f46e5;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }

    /* Responsive */
    @media (max-width: 768px) {
      .user-management {
        padding: 15px;
      }

      .controls {
        flex-direction: column;
        align-items: stretch;
      }

      .filters {
        justify-content: center;
      }

      .search-input {
        width: 100%;
        max-width: 250px;
      }

      .users-table {
        font-size: 14px;
      }

      .users-table th,
      .users-table td {
        padding: 10px 8px;
      }

      .user-info {
        flex-direction: column;
        align-items: flex-start;
        gap: 5px;
      }

      .user-avatar {
        width: 30px;
        height: 30px;
        font-size: 14px;
      }

      .action-buttons {
        flex-direction: column;
        align-items: flex-start;
      }

      .pagination {
        flex-direction: column;
        gap: 10px;
      }

      .modal-content {
        width: 95%;
        margin: 10px;
      }
    }
  `]
})
export class UserManagementComponent implements OnInit {
  users: User[] = [];
  pagination: any = null;
  currentUserId: string = '';
  canManageUsers: boolean = false;

  // Filters
  searchTerm: string = '';
  roleFilter: string = '';
  statusFilter: string = '';

  // Modal states
  showUserModal: boolean = false;
  showPasswordModal: boolean = false;
  editingUser: User | null = null;
  isLoading: boolean = false;

  // Forms
  userForm: FormGroup;
  passwordForm: FormGroup;

  constructor(
    private userService: UserService,
    private authService: AuthService,
    private fb: FormBuilder
  ) {
    this.userForm = this.fb.group({
      name: ['', [Validators.required, Validators.minLength(2)]],
      email: ['', [Validators.required, Validators.email, Validators.pattern(/@buildinginfo\.com$/)]],
      password: ['', [Validators.required, Validators.pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/)]],
      role: ['operator', Validators.required],
      department: [''],
      jobTitle: [''],
      isActive: [true]
    });

    this.passwordForm = this.fb.group({
      currentPassword: ['', Validators.required],
      newPassword: ['', [Validators.required, Validators.pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/)]],
      confirmPassword: ['', Validators.required]
    }, { validators: this.passwordMatchValidator });
  }

  ngOnInit() {
    this.loadCurrentUser();
    this.loadUsers();
  }

  loadCurrentUser() {
    this.authService.getCurrentUser().subscribe({
      next: (response) => {
        if (response.success) {
          this.currentUserId = response.data.user.id;
          this.canManageUsers = response.data.user.permissions?.canManageUsers || false;
        }
      },
      error: (error) => {
        console.error('Error loading current user:', error);
      }
    });
  }

  loadUsers() {
    this.isLoading = true;
    const filters: any = {};

    if (this.roleFilter) filters.role = this.roleFilter;
    if (this.statusFilter) filters.active = this.statusFilter === 'true';
    if (this.searchTerm) filters.search = this.searchTerm;

    this.userService.getUsers(1, 20, filters).subscribe({
      next: (response) => {
        this.users = response.data.users;
        this.pagination = response.data.pagination;
        this.isLoading = false;
      },
      error: (error) => {
        console.error('Error loading users:', error);
        this.isLoading = false;
      }
    });
  }

  changePage(page: number) {
    if (page >= 1 && page <= this.pagination.totalPages) {
      // Implement pagination
      this.loadUsers();
    }
  }

  openCreateUserModal() {
    this.editingUser = null;
    this.userForm.reset({
      role: 'operator',
      isActive: true
    });
    this.userForm.get('email')?.enable();
    this.userForm.get('password')?.enable();
    this.showUserModal = true;
  }

  openEditUserModal(user: User) {
    this.editingUser = user;
    this.userForm.patchValue({
      name: user.name,
      role: user.role,
      department: user.department,
      jobTitle: user.jobTitle,
      isActive: user.isActive ?? true
    });
    this.userForm.get('email')?.disable();
    this.userForm.get('password')?.disable();
    this.showUserModal = true;
  }

  openChangePasswordModal(user: User) {
    this.editingUser = user;
    this.passwordForm.reset();
    this.showPasswordModal = true;
  }

  closeUserModal() {
    this.showUserModal = false;
    this.editingUser = null;
  }

  closePasswordModal() {
    this.showPasswordModal = false;
    this.editingUser = null;
  }

  saveUser() {
    if (this.userForm.valid && !this.isLoading) {
      this.isLoading = true;
      const formData = this.userForm.value;

      if (this.editingUser) {
        // Update existing user
        const updateData: UpdateUserRequest = {
          name: formData.name,
          role: formData.role,
          department: formData.department,
          jobTitle: formData.jobTitle,
          isActive: formData.isActive
        };

        this.userService.updateUser(this.editingUser.id, updateData).subscribe({
          next: () => {
            this.loadUsers();
            this.closeUserModal();
            this.isLoading = false;
          },
          error: (error) => {
            console.error('Error updating user:', error);
            this.isLoading = false;
          }
        });
      } else {
        // Create new user
        const createData: CreateUserRequest = {
          name: formData.name,
          email: formData.email,
          password: formData.password,
          role: formData.role,
          department: formData.department,
          jobTitle: formData.jobTitle
        };

        this.userService.createUser(createData).subscribe({
          next: () => {
            this.loadUsers();
            this.closeUserModal();
            this.isLoading = false;
          },
          error: (error) => {
            console.error('Error creating user:', error);
            this.isLoading = false;
          }
        });
      }
    }
  }

  changePassword() {
    if (this.passwordForm.valid && !this.isLoading) {
      this.isLoading = true;
      const formData = this.passwordForm.value;

      this.userService.changePassword({
        currentPassword: formData.currentPassword,
        newPassword: formData.newPassword
      }).subscribe({
        next: () => {
          this.closePasswordModal();
          this.isLoading = false;
        },
        error: (error) => {
          console.error('Error changing password:', error);
          this.isLoading = false;
        }
      });
    }
  }

  toggleUserStatus(user: User) {
    if (!this.canManageUsers || user.id === this.currentUserId) return;

    this.isLoading = true;
    this.userService.updateUser(user.id, { isActive: !user.isActive }).subscribe({
      next: () => {
        this.loadUsers();
        this.isLoading = false;
      },
      error: (error) => {
        console.error('Error toggling user status:', error);
        this.isLoading = false;
      }
    });
  }

  formatDate(date: Date | string | undefined): string {
    if (!date) return 'Never';
    const d = new Date(date);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  passwordMatchValidator(group: FormGroup) {
    const newPassword = group.get('newPassword');
    const confirmPassword = group.get('confirmPassword');

    if (newPassword && confirmPassword && newPassword.value !== confirmPassword.value) {
      confirmPassword.setErrors({ passwordMismatch: true });
    }

    return null;
  }
}