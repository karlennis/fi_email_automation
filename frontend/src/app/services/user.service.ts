import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface User {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'operator';
  permissions: {
    canManageUsers: boolean;
    canManageJobs: boolean;
    canViewAllJobs: boolean;
    canManageSystem: boolean;
  };
  department?: string;
  jobTitle?: string;
  isActive: boolean;
  lastLogin?: Date;
  lastActivity?: Date;
  loginCount?: number;
  createdAt: Date;
  updatedAt?: Date;
}

export interface CreateUserRequest {
  name: string;
  email: string;
  password: string;
  role?: 'admin' | 'operator';
  department?: string;
  jobTitle?: string;
}

export interface UpdateUserRequest {
  name?: string;
  role?: 'admin' | 'operator';
  department?: string;
  jobTitle?: string;
  isActive?: boolean;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

export interface UsersResponse {
  success: boolean;
  data: {
    users: User[];
    pagination: {
      currentPage: number;
      totalPages: number;
      totalUsers: number;
      hasNextPage: boolean;
      hasPrevPage: boolean;
    };
  };
}

@Injectable({
  providedIn: 'root'
})
export class UserService {
  private apiUrl = `${environment.apiUrl}/api/auth`;

  constructor(private http: HttpClient) {}

  /**
   * Get all users (Admin only)
   */
  getUsers(page: number = 1, limit: number = 20, filters?: {
    role?: string;
    active?: boolean;
    search?: string;
  }): Observable<UsersResponse> {
    let params = new HttpParams()
      .set('page', page.toString())
      .set('limit', limit.toString());

    if (filters?.role) {
      params = params.set('role', filters.role);
    }
    if (filters?.active !== undefined) {
      params = params.set('active', filters.active.toString());
    }
    if (filters?.search) {
      params = params.set('search', filters.search);
    }

    return this.http.get<UsersResponse>(`${this.apiUrl}/users`, { params });
  }

  /**
   * Create new user (Admin only)
   */
  createUser(userData: CreateUserRequest): Observable<any> {
    return this.http.post(`${this.apiUrl}/register`, userData);
  }

  /**
   * Update user (Admin only)
   */
  updateUser(userId: string, updates: UpdateUserRequest): Observable<any> {
    return this.http.put(`${this.apiUrl}/users/${userId}`, updates);
  }

  /**
   * Deactivate user (Admin only)
   */
  deactivateUser(userId: string): Observable<any> {
    return this.http.delete(`${this.apiUrl}/users/${userId}`);
  }

  /**
   * Change password
   */
  changePassword(passwordData: ChangePasswordRequest): Observable<any> {
    return this.http.post(`${this.apiUrl}/change-password`, passwordData);
  }

  /**
   * Get current user profile
   */
  getCurrentUser(): Observable<any> {
    return this.http.get(`${this.apiUrl}/me`);
  }
}