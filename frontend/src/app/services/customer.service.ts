import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { AuthService } from './auth.service';
import { environment } from '../../environments/environment';

export interface Customer {
  _id: string;
  name: string;
  email: string;
  phone?: string;
  company?: string;
  reportTypes: string[];
  filters?: {
    allowedCounties: string[];
    allowedSectors: string[];
  };
  isActive: boolean;
  emailCount: number;
  lastEmailSent?: Date;
  emailPreferences: {
    instantNotification: boolean;
    dailyDigest: boolean;
    weeklyDigest: boolean;
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface FINotification {
  customerEmail: string;
  customerName: string;
  sentAt: Date;
  messageId: string;
  status: 'sent' | 'delivered' | 'failed';
}

export interface FIHistoryItem {
  _id: string;
  projectId: string;
  project: {
    title: string;
    projectId: string;
    planningAuthority: string;
    location: string;
  };
  reportType: string;
  fileName: string;
  status: string;
  confidence: number;
  requestDate?: Date;
  deadline?: Date;
  createdAt: Date;
  notifications: FINotification[];
}

export interface CustomerHistory {
  customer: Customer;
  fiHistory: FIHistoryItem[];
  totalReports: number;
}

export interface EmailSuggestion {
  email: string;
  name: string;
  company?: string;
  displayText: string;
  reportTypes: string[];
  emailCount: number;
}

export interface CustomerRequest {
  name: string;
  email: string;
  phone?: string;
  company?: string;
  reportTypes?: string[];
  filters?: {
    allowedCounties?: string[];
    allowedSectors?: string[];
  };
  isActive?: boolean;
  emailPreferences?: {
    instantNotification?: boolean;
    dailyDigest?: boolean;
    weeklyDigest?: boolean;
  };
}

export interface CustomerResponse {
  success: boolean;
  data: Customer | Customer[];
  pagination?: {
    total: number;
    pages: number;
    current: number;
    limit: number;
  };
}

@Injectable({
  providedIn: 'root'
})
export class CustomerService {
  private baseUrl = `${environment.apiUrl}/api/customers`;

  constructor(
    private http: HttpClient,
    private authService: AuthService
  ) {}

  getCustomers(params?: {
    page?: number;
    limit?: number;
    search?: string;
    subscription?: string;
    isActive?: boolean;
  }): Observable<{ customers: Customer[]; pagination: any }> {
    const headers = this.authService.getAuthHeaders();
    return this.http.get<CustomerResponse>(this.baseUrl, {
      headers,
      params: params as any
    }).pipe(
      map(response => ({
        customers: response.data as Customer[],
        pagination: response.pagination
      }))
    );
  }

  getCustomer(id: string): Observable<Customer> {
    const headers = this.authService.getAuthHeaders();
    return this.http.get<CustomerResponse>(`${this.baseUrl}/${id}`, { headers })
      .pipe(map(response => response.data as Customer));
  }

  createCustomer(customer: CustomerRequest): Observable<Customer> {
    const headers = this.authService.getAuthHeaders();
    return this.http.post<CustomerResponse>(this.baseUrl, customer, { headers })
      .pipe(map(response => response.data as Customer));
  }

  updateCustomer(id: string, customer: Partial<CustomerRequest>): Observable<Customer> {
    const headers = this.authService.getAuthHeaders();
    return this.http.put<CustomerResponse>(`${this.baseUrl}/${id}`, customer, { headers })
      .pipe(map(response => response.data as Customer));
  }

  deleteCustomer(id: string): Observable<void> {
    const headers = this.authService.getAuthHeaders();
    return this.http.delete<{ success: boolean }>(`${this.baseUrl}/${id}`, { headers })
      .pipe(map(() => void 0));
  }

  addSubscription(id: string, subscription: string): Observable<Customer> {
    const headers = this.authService.getAuthHeaders();
    return this.http.post<CustomerResponse>(`${this.baseUrl}/${id}/subscriptions`,
      { subscription }, { headers })
      .pipe(map(response => response.data as Customer));
  }

  removeSubscription(id: string, subscription: string): Observable<Customer> {
    const headers = this.authService.getAuthHeaders();
    return this.http.delete<CustomerResponse>(`${this.baseUrl}/${id}/subscriptions/${subscription}`,
      { headers })
      .pipe(map(response => response.data as Customer));
  }

  // Get FI report history for a specific customer
  getCustomerFIHistory(id: string): Observable<CustomerHistory> {
    const headers = this.authService.getAuthHeaders();
    return this.http.get<{ success: boolean; data: CustomerHistory }>(`${this.baseUrl}/${id}/fi-history`, { headers })
      .pipe(map(response => response.data));
  }

  // Get customers for quick email selection
  getQuickSelectCustomers(reportType?: string): Observable<Customer[]> {
    const headers = this.authService.getAuthHeaders();
    const params: any = {};
    if (reportType) {
      params.reportType = reportType;
    }
    return this.http.get<{ success: boolean; data: Customer[] }>(`${this.baseUrl}/quick-select`, {
      headers,
      params
    }).pipe(map(response => response.data));
  }

  // Get email suggestions for autocomplete
  getEmailSuggestions(query: string, reportType?: string): Observable<EmailSuggestion[]> {
    const headers = this.authService.getAuthHeaders();
    const params: any = { q: query };
    if (reportType) params.reportType = reportType;

    return this.http.get<{ success: boolean; data: EmailSuggestion[] }>(`${this.baseUrl}/email-suggestions`, {
      headers,
      params
    }).pipe(map(response => response.data));
  }

  // Toggle customer status
  toggleCustomerStatus(id: string): Observable<Customer> {
    const headers = this.authService.getAuthHeaders();
    return this.http.post<CustomerResponse>(`${this.baseUrl}/${id}/toggle-status`, {}, { headers })
      .pipe(map(response => response.data as Customer));
  }
}
