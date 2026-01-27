import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { environment } from '../../environments/environment';

export interface FilteringParams {
  [key: string]: any; // Index signature for dynamic access
  category?: number | number[]; // Can be single ID or array of IDs
  subcategory?: number | number[]; // Can be single ID or array of IDs
  county?: number | number[]; // Can be single ID or array of IDs
  stage?: number | number[]; // Can be single ID or array of IDs
  type?: number | number[]; // Can be single ID or array of IDs
  apion?: number | string; // All updates filter (api_date field) - use for relative dates
  min_apion?: string; // All updates from date: -1z (yesterday 00:00), -12z (12 days ago 00:00), 0z (today 00:00), 'now', 'today'
  max_apion?: string; // Max date for range (YYYY-MM-DD) - only used when apion=8
  limit?: number;
  offset?: number;
}

export interface DropdownData {
  categories: Array<{ id: number; name: string; subcategories: Array<{ id: number; name: string }> }>;
  counties: Array<{ id: number; name: string }>;
  stages: Array<{ id: number; name: string }>;
  types: Array<{ id: number; name: string }>;
}

export interface ProjectPreview {
  projectId: string;
  title: string;
  category: string;
  subcategory: string;
  county: string;
  stage: string;
  type: string;
  planningAuthority: string;
}

export interface FilteredProjectsResponse {
  projects: ProjectPreview[];
  totalCount: number;
  limit: number;
  offset: number;
  filters: FilteringParams;
}

export interface FilterValidationResponse {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface ProcessingResponse {
  success: boolean;
  message: string;
  processed: number;
  errors: any[];
}

@Injectable({
  providedIn: 'root'
})
export class ApiFilteringService {
  private baseUrl = `${environment.apiUrl}/api/filtering`;

  constructor(private http: HttpClient) {}

  /**
   * Get all dropdown data for filtering
   */
  getDropdownData(): Observable<DropdownData> {
    return this.http.get<{success: boolean, data: DropdownData}>(`${this.baseUrl}/dropdown-data`)
      .pipe(
        map((response: {success: boolean, data: DropdownData}) => response.data)
      );
  }

  /**
   * Preview projects based on filtering parameters
   */
  previewProjects(params: FilteringParams): Observable<FilteredProjectsResponse> {
    return this.http.post<{success: boolean, data: FilteredProjectsResponse}>(`${this.baseUrl}/preview-projects`, { apiParams: params })
      .pipe(
        map((response: {success: boolean, data: FilteredProjectsResponse}) => response.data)
      );
  }

  /**
   * Validate filtering parameters
   */
  validateParams(params: FilteringParams): Observable<FilterValidationResponse> {
    return this.http.post<{success: boolean, valid: boolean, errors?: string[], warnings?: string[], summary?: string}>(`${this.baseUrl}/validate-params`, params)
      .pipe(
        map((response: {success: boolean, valid: boolean, errors?: string[], warnings?: string[], summary?: string}) => ({
          valid: response.valid,
          errors: response.errors || [],
          warnings: response.warnings || []
        }))
      );
  }

  /**
   * Process FI detection with filters
   */
  processFIWithFilters(params: {
    filters: FilteringParams;
    customers: Array<{ name: string; email: string }>;
    reportTypes: string[];
    processingMode: 'immediate' | 'scheduled';
    scheduleTime?: string;
  }): Observable<ProcessingResponse> {
    return this.http.post<ProcessingResponse>(`${this.baseUrl}/process-fi-with-filters`, params);
  }
}