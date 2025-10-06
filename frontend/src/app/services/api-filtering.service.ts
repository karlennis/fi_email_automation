import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface FilteringParams {
  category?: number;
  subcategory?: number;
  county?: number;
  stage?: number;
  type?: number;
  apion?: number | string; // Date filter: 3 (today), -1.1 (yesterday), 0.7 (past 7 days), etc.
  min_apion?: string; // Min date for range (YYYY-MM-DD)
  max_apion?: string; // Max date for range (YYYY-MM-DD)
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
  private baseUrl = 'http://localhost:3000/api/filtering';

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