import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, BehaviorSubject } from 'rxjs';
import { map, tap } from 'rxjs/operators';
import { environment } from '../../environments/environment';

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'operator';
  permissions?: {
    canManageUsers: boolean;
    canManageJobs: boolean;
    canViewAllJobs: boolean;
    canManageSystem: boolean;
  };
  department?: string;
  jobTitle?: string;
  isActive?: boolean;
  lastLogin?: Date;
  lastActivity?: Date;
  loginCount?: number;
  createdAt: Date;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  name: string;
  email: string;
  password: string;
  role?: 'admin' | 'operator';
  department?: string;
  jobTitle?: string;
}

export interface AuthResponse {
  success: boolean;
  data: {
    user: User;
    token: string;
  };
}

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private baseUrl = `${environment.apiUrl}/api`;
  private currentUserSubject = new BehaviorSubject<User | null>(null);
  public currentUser$ = this.currentUserSubject.asObservable();

  constructor(private http: HttpClient) {
    // Check if user is already logged in (only in browser)
    if (typeof window !== 'undefined' && localStorage) {
      const token = localStorage.getItem('token');
      const user = localStorage.getItem('user');
      if (token && user) {
        this.currentUserSubject.next(JSON.parse(user));
      }
    }
  }

  get currentUserValue(): User | null {
    return this.currentUserSubject.value;
  }

  get isAuthenticated(): boolean {
    return !!this.currentUserValue;
  }

  get isAdmin(): boolean {
    return this.currentUserValue?.role === 'admin';
  }

  login(credentials: LoginRequest): Observable<AuthResponse> {
    return this.http.post<AuthResponse>(`${this.baseUrl}/auth/login`, credentials)
      .pipe(
        tap(response => {
          if (response.success && typeof window !== 'undefined' && localStorage) {
            localStorage.setItem('token', response.data.token);
            localStorage.setItem('user', JSON.stringify(response.data.user));
            this.currentUserSubject.next(response.data.user);
          }
        })
      );
  }

  register(userData: RegisterRequest): Observable<AuthResponse> {
    return this.http.post<AuthResponse>(`${this.baseUrl}/auth/register`, userData)
      .pipe(
        tap(response => {
          if (response.success && typeof window !== 'undefined' && localStorage) {
            localStorage.setItem('token', response.data.token);
            localStorage.setItem('user', JSON.stringify(response.data.user));
            this.currentUserSubject.next(response.data.user);
          }
        })
      );
  }

  logout(): void {
    if (typeof window !== 'undefined' && localStorage) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
    }
    this.currentUserSubject.next(null);
  }

  getProfile(): Observable<User> {
    return this.http.get<{ success: boolean; data: User }>(`${this.baseUrl}/auth/profile`)
      .pipe(map(response => response.data));
  }

  updateProfile(userData: Partial<User>): Observable<User> {
    return this.http.put<{ success: boolean; data: User }>(`${this.baseUrl}/auth/profile`, userData)
      .pipe(map(response => response.data));
  }

  /**
   * Get current user information
   */
  getCurrentUser(): Observable<any> {
    return this.http.get(`${this.baseUrl}/auth/me`, {
      headers: this.getAuthHeaders()
    });
  }

  /**
   * Get authorization headers
   */
  getAuthHeaders(): HttpHeaders {
    const token = typeof window !== 'undefined' && localStorage ? localStorage.getItem('token') : null;
    return new HttpHeaders({
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    });
  }

  /**
   * Refresh user permissions
   */
  refreshPermissions(): Observable<any> {
    return this.getCurrentUser().pipe(
      map(response => {
        if (response.success && response.data) {
          const user = response.data;
          localStorage.setItem('user', JSON.stringify(user));
          this.currentUserSubject.next(user);
        }
        return response.data;
      })
    );
  }
}
