import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface ScheduledJob {
  _id: string;
  jobId: string;
  jobType: 'REPORT_GENERATION' | 'EMAIL_BATCH' | 'FI_DETECTION';
  status: 'SCHEDULED' | 'PROCESSING' | 'CACHED' | 'SENDING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'PAUSED';
  schedule: {
    type: 'IMMEDIATE' | 'ONCE' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'CRON';
    cronExpression?: string;
    scheduledFor?: Date;
    dayOfWeek?: number; // 0-6 (Sunday=0)
    dayOfMonth?: number; // 1-31
    timeOfDay?: string; // HH:mm
    timezone: string;
  };
  customers: Array<{
    customerId: string;
    email: string;
    name: string;
    sendStatus: 'PENDING' | 'SENT' | 'FAILED' | 'BOUNCED';
    sentAt?: Date;
    errorMessage?: string;
  }>;
  config: {
    reportTypes: string[];
    projectIds: string[];
    searchCriteria?: any;
    emailTemplate: string;
    customSubject?: string;
    attachReports: boolean;
  };
  cache?: {
    reportIds: string[];
    s3Paths: string[];
    previewHtml?: string;
    generatedAt: Date;
    expiresAt: Date;
  };
  execution: {
    lastRunAt?: Date;
    nextRunAt?: Date;
    runCount: number;
    successCount: number;
    failureCount: number;
    avgProcessingTime?: number;
    lastError?: {
      message: string;
      timestamp: Date;
      stack?: string;
    };
  };
  emailStats: {
    totalEmails: number;
    sentEmails: number;
    failedEmails: number;
    bouncedEmails: number;
  };
  createdBy?: {
    userId: string;
    username: string;
    email: string;
  };
  modifiedBy?: {
    userId: string;
    username: string;
    email: string;
    modifiedAt: Date;
  };
  executionHistory?: Array<{
    executedBy: {
      userId: string;
      username: string;
      email: string;
    };
    executedAt: Date;
    action: 'CREATED' | 'STARTED' | 'CANCELLED' | 'COMPLETED' | 'FAILED' | 'MODIFIED';
    details: string;
    result?: any;
  }>;
  isActive: boolean;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
  progress?: number; // Virtual field
  isCacheExpired?: boolean; // Virtual field
}

export interface CreateJobRequest {
  jobType: 'REPORT_GENERATION' | 'EMAIL_BATCH' | 'FI_DETECTION';
  scheduleType: 'IMMEDIATE' | 'ONCE' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'CRON';
  cronExpression?: string;
  scheduledFor?: Date | string;
  dayOfWeek?: number;
  dayOfMonth?: number;
  timeOfDay?: string;
  timezone?: string;
  reportTypes: string[];
  projectIds?: string[];
  searchCriteria?: any;
  customerIds: string[];
  emailTemplate?: string;
  customSubject?: string;
  attachReports?: boolean;
  notes?: string;
}

export interface JobListFilter {
  status?: string;
  jobType?: string;
  isActive?: boolean;
  limit?: number;
  page?: number;
}

export interface JobStatistics {
  total: number;
  active: number;
  byStatus: {
    [key: string]: number;
  };
  byType: {
    [key: string]: number;
  };
  averageProcessingTime?: number;
  successRate?: number;
}

export interface ApiResponse<T> {
  success: boolean;
  message?: string;
  data: T;
  error?: string;
}

@Injectable({
  providedIn: 'root'
})
export class ScheduledJobsService {
  private apiUrl = 'http://localhost:3000/api/scheduled-jobs';

  constructor(private http: HttpClient) {}

  /**
   * Create a new scheduled job
   */
  createJob(jobData: CreateJobRequest): Observable<ApiResponse<ScheduledJob>> {
    return this.http.post<ApiResponse<ScheduledJob>>(`${this.apiUrl}/create`, jobData);
  }

  /**
   * Get list of scheduled jobs with optional filters
   */
  getJobs(filters?: JobListFilter): Observable<ApiResponse<{ jobs: ScheduledJob[], pagination: any }>> {
    let params = new HttpParams();

    if (filters) {
      if (filters.status) params = params.set('status', filters.status);
      if (filters.jobType) params = params.set('jobType', filters.jobType);
      if (filters.isActive !== undefined) params = params.set('isActive', filters.isActive.toString());
      if (filters.limit) params = params.set('limit', filters.limit.toString());
      if (filters.page) params = params.set('page', filters.page.toString());
    }

    return this.http.get<ApiResponse<{ jobs: ScheduledJob[], pagination: any }>>(`${this.apiUrl}/list`, { params });
  }

  /**
   * Get a specific job by ID
   */
  getJobById(jobId: string): Observable<ApiResponse<ScheduledJob>> {
    return this.http.get<ApiResponse<ScheduledJob>>(`${this.apiUrl}/${jobId}`);
  }

  /**
   * Update a scheduled job
   */
  updateJob(jobId: string, updates: Partial<CreateJobRequest>): Observable<ApiResponse<ScheduledJob>> {
    return this.http.put<ApiResponse<ScheduledJob>>(`${this.apiUrl}/${jobId}`, updates);
  }

  /**
   * Cancel a scheduled job
   */
  cancelJob(jobId: string): Observable<ApiResponse<ScheduledJob>> {
    return this.http.post<ApiResponse<ScheduledJob>>(`${this.apiUrl}/${jobId}/cancel`, {});
  }

  /**
   * Pause a scheduled job
   */
  pauseJob(jobId: string): Observable<ApiResponse<ScheduledJob>> {
    return this.http.post<ApiResponse<ScheduledJob>>(`${this.apiUrl}/${jobId}/pause`, {});
  }

  /**
   * Resume a paused job
   */
  resumeJob(jobId: string): Observable<ApiResponse<ScheduledJob>> {
    return this.http.post<ApiResponse<ScheduledJob>>(`${this.apiUrl}/${jobId}/resume`, {});
  }

  /**
   * Execute a job immediately (regardless of schedule)
   */
  executeJobNow(jobId: string): Observable<ApiResponse<any>> {
    return this.http.post<ApiResponse<any>>(`${this.apiUrl}/${jobId}/execute-now`, {});
  }

  /**
   * Get dashboard statistics
   */
  getDashboardStats(): Observable<ApiResponse<JobStatistics>> {
    return this.http.get<ApiResponse<JobStatistics>>(`${this.apiUrl}/dashboard/stats`);
  }

  /**
   * Get upcoming scheduled jobs
   */
  getUpcomingJobs(limit: number = 5): Observable<ApiResponse<ScheduledJob[]>> {
    const params = new HttpParams().set('limit', limit.toString());
    return this.http.get<ApiResponse<ScheduledJob[]>>(`${this.apiUrl}/dashboard/upcoming`, { params });
  }

  /**
   * Get recently completed/failed jobs
   */
  getRecentJobs(limit: number = 10): Observable<ApiResponse<ScheduledJob[]>> {
    const params = new HttpParams().set('limit', limit.toString());
    return this.http.get<ApiResponse<ScheduledJob[]>>(`${this.apiUrl}/dashboard/recent`, { params });
  }

  /**
   * Get customer send status for a job
   */
  getJobCustomers(jobId: string): Observable<ApiResponse<{ customers: any[], stats: any }>> {
    return this.http.get<ApiResponse<{ customers: any[], stats: any }>>(`${this.apiUrl}/${jobId}/customers`);
  }

  /**
   * Send immediate email (legacy support)
   */
  sendImmediate(data: {
    reportTypes: string[];
    projectIds: string[];
    customerIds: string[];
    emailTemplate?: string;
    customSubject?: string;
  }): Observable<ApiResponse<any>> {
    return this.http.post<ApiResponse<any>>(`${this.apiUrl}/send-immediate`, data);
  }

  /**
   * Helper method to get status badge class
   */
  getStatusClass(status: string): string {
    const statusClasses: { [key: string]: string } = {
      'SCHEDULED': 'status-scheduled',
      'PROCESSING': 'status-processing',
      'CACHED': 'status-cached',
      'SENDING': 'status-sending',
      'COMPLETED': 'status-completed',
      'FAILED': 'status-failed',
      'CANCELLED': 'status-cancelled',
      'PAUSED': 'status-paused'
    };
    return statusClasses[status] || 'status-default';
  }

  /**
   * Helper method to format schedule description
   */
  getScheduleDescription(job: ScheduledJob): string {
    const { schedule } = job;

    switch (schedule.type) {
      case 'IMMEDIATE':
        return 'Run immediately';
      case 'ONCE':
        return `Once on ${new Date(schedule.scheduledFor!).toLocaleString()}`;
      case 'DAILY':
        return `Daily at ${schedule.timeOfDay}`;
      case 'WEEKLY':
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        return `Weekly on ${days[schedule.dayOfWeek!]} at ${schedule.timeOfDay}`;
      case 'MONTHLY':
        return `Monthly on day ${schedule.dayOfMonth} at ${schedule.timeOfDay}`;
      case 'CRON':
        return `Cron: ${schedule.cronExpression}`;
      default:
        return 'Unknown schedule';
    }
  }

  /**
   * Helper method to format next run time
   */
  getNextRunDescription(job: ScheduledJob): string {
    if (!job.execution.nextRunAt) {
      return 'No upcoming run';
    }

    const nextRun = new Date(job.execution.nextRunAt);
    const now = new Date();
    const diff = nextRun.getTime() - now.getTime();

    if (diff < 0) {
      return 'Overdue';
    }

    const minutes = Math.floor(diff / (1000 * 60));
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `In ${days} day${days > 1 ? 's' : ''}`;
    } else if (hours > 0) {
      return `In ${hours} hour${hours > 1 ? 's' : ''}`;
    } else if (minutes > 0) {
      return `In ${minutes} minute${minutes > 1 ? 's' : ''}`;
    } else {
      return 'In less than a minute';
    }
  }
}
