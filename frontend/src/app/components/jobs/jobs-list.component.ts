import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ToastrService } from 'ngx-toastr';
import { ScheduledJobsService, ScheduledJob, JobStatistics } from '../../services/scheduled-jobs.service';
import { interval, Subscription } from 'rxjs';

@Component({
  selector: 'app-jobs-list',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="jobs-container">
      <!-- Header -->
      <div class="jobs-header">
        <div>
          <h1>Scheduled Jobs</h1>
          <p>Monitor and manage automated email jobs</p>
        </div>
        <button class="btn-refresh" (click)="refreshData()">
          <i class="icon-refresh"></i> Refresh
        </button>
      </div>

      <!-- Dashboard Stats -->
      <div class="dashboard-stats" *ngIf="stats">
        <div class="stat-card">
          <div class="stat-value">{{ stats.total }}</div>
          <div class="stat-label">Total Jobs</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ stats.active }}</div>
          <div class="stat-label">Active Jobs</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ stats.byStatus['SCHEDULED'] || 0 }}</div>
          <div class="stat-label">Scheduled</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ stats.byStatus['PROCESSING'] || 0 }}</div>
          <div class="stat-label">Processing</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ stats.byStatus['COMPLETED'] || 0 }}</div>
          <div class="stat-label">Completed</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ stats.byStatus['FAILED'] || 0 }}</div>
          <div class="stat-label">Failed</div>
        </div>
      </div>

      <!-- Filters -->
      <div class="filters-section">
        <div class="filter-group">
          <label>Status:</label>
          <select [(ngModel)]="filterStatus" (change)="loadJobs()">
            <option value="">All</option>
            <option value="SCHEDULED">Scheduled</option>
            <option value="PROCESSING">Processing</option>
            <option value="CACHED">Cached</option>
            <option value="SENDING">Sending</option>
            <option value="COMPLETED">Completed</option>
            <option value="FAILED">Failed</option>
            <option value="CANCELLED">Cancelled</option>
            <option value="PAUSED">Paused</option>
          </select>
        </div>

        <div class="filter-group">
          <label>Type:</label>
          <select [(ngModel)]="filterType" (change)="loadJobs()">
            <option value="">All</option>
            <option value="REPORT_GENERATION">Report Generation</option>
            <option value="EMAIL_BATCH">Email Batch</option>
            <option value="FI_DETECTION">FI Detection</option>
          </select>
        </div>

        <div class="filter-group">
          <label>Active Only:</label>
          <input type="checkbox" [(ngModel)]="filterActive" (change)="loadJobs()">
        </div>
      </div>

      <!-- Upcoming Jobs -->
      <div class="section" *ngIf="upcomingJobs.length > 0">
        <h2>Upcoming Jobs</h2>
        <div class="jobs-grid upcoming-jobs">
          <div class="job-card upcoming" *ngFor="let job of upcomingJobs">
            <div class="job-header">
              <span class="job-id">{{ job.jobId }}</span>
              <span class="status-badge" [ngClass]="getStatusClass(job.status)">
                {{ job.status }}
              </span>
            </div>
            <div class="job-body">
              <div class="job-info">
                <strong>{{ getJobTypeLabel(job.jobType) }}</strong>
                <p class="schedule-info">{{ getScheduleDescription(job) }}</p>
                <p class="next-run">
                  <i class="icon-clock"></i>
                  {{ getNextRunDescription(job) }}
                </p>
              </div>
              <div class="job-stats">
                <span class="stat">
                  <i class="icon-users"></i>
                  {{ job.customers.length }} customers
                </span>
                <span class="stat">
                  <i class="icon-reports"></i>
                  {{ job.config.reportTypes.length }} report types
                </span>
              </div>
            </div>
            <div class="job-actions">
              <button class="btn-icon" (click)="viewJob(job)" title="View Details">
                <i class="icon-eye"></i>
              </button>
              <button
                class="btn-icon"
                (click)="executeNow(job)"
                [disabled]="job.status === 'PROCESSING' || job.status === 'SENDING'"
                title="Execute Now">
                <i class="icon-play"></i>
              </button>
              <button
                *ngIf="job.status !== 'PAUSED'"
                class="btn-icon"
                (click)="pauseJob(job)"
                title="Pause">
                <i class="icon-pause"></i>
              </button>
              <button
                *ngIf="job.status === 'PAUSED'"
                class="btn-icon"
                (click)="resumeJob(job)"
                title="Resume">
                <i class="icon-play-circle"></i>
              </button>
              <button class="btn-icon danger" (click)="cancelJob(job)" title="Cancel">
                <i class="icon-cancel"></i>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- All Jobs -->
      <div class="section">
        <h2>All Jobs ({{ pagination?.total || 0 }})</h2>

        <div class="loading" *ngIf="loading">
          <div class="spinner"></div>
          <p>Loading jobs...</p>
        </div>

        <div class="jobs-table" *ngIf="!loading && jobs.length > 0">
          <table>
            <thead>
              <tr>
                <th>Job ID</th>
                <th>Type</th>
                <th>Schedule</th>
                <th>Status</th>
                <th>Operator</th>
                <th>Customers</th>
                <th>Next Run</th>
              </tr>
            </thead>
            <tbody>
              <tr *ngFor="let job of jobs" [ngClass]="{'row-inactive': !job.isActive}">
                <td>
                  <span class="job-id-link" (click)="viewJob(job)">
                    {{ job.jobId }}
                  </span>
                  <br>
                  <small class="text-muted">{{ job.createdAt | date: 'short' }}</small>
                </td>
                <td>
                  <span class="job-type-badge">{{ getJobTypeLabel(job.jobType) }}</span>
                </td>
                <td>
                  <div class="schedule-cell">
                    <div>{{ getScheduleDescription(job) }}</div>
                    <small class="text-muted">{{ job.schedule.timezone }}</small>
                  </div>
                </td>
                <td>
                  <span class="status-badge" [ngClass]="getStatusClass(job.status)">
                    {{ job.status }}
                  </span>
                </td>
                <td>
                  <div class="operator-cell">
                    <div class="operator-name" *ngIf="getLastOperator(job) as operator; else systemOperator">
                      {{ operator.username }}
                    </div>
                    <ng-template #systemOperator>
                      <span class="text-muted">System</span>
                    </ng-template>
                    <button
                      *ngIf="job.status !== 'CANCELLED' && job.status !== 'COMPLETED' && job.status !== 'FAILED'"
                      class="btn-cancel-small"
                      (click)="cancelJob(job)"
                      title="Cancel Job">
                      Cancel
                    </button>
                  </div>
                </td>
                <td>{{ job.customers.length }}</td>
                <td>
                  <div class="next-run-cell" *ngIf="job.execution.nextRunAt">
                    <div>{{ job.execution.nextRunAt | date: 'short' }}</div>
                    <small class="text-muted">{{ getNextRunDescription(job) }}</small>
                  </div>
                  <span *ngIf="!job.execution.nextRunAt" class="text-muted">-</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="no-data" *ngIf="!loading && jobs.length === 0">
          <i class="icon-inbox"></i>
          <p>No jobs found</p>
          <p class="text-muted">Create your first scheduled job to get started</p>
        </div>

        <!-- Pagination -->
        <div class="pagination" *ngIf="pagination && pagination.pages > 1">
          <button
            class="btn-pagination"
            (click)="previousPage()"
            [disabled]="pagination.page === 1">
            Previous
          </button>
          <span class="page-info">
            Page {{ pagination.page }} of {{ pagination.pages }}
          </span>
          <button
            class="btn-pagination"
            (click)="nextPage()"
            [disabled]="pagination.page === pagination.pages">
            Next
          </button>
        </div>
      </div>

      <!-- Recent Jobs -->
      <div class="section" *ngIf="recentJobs.length > 0">
        <h2>Recent Activity</h2>
        <div class="recent-jobs">
          <div class="recent-job-item" *ngFor="let job of recentJobs">
            <div class="recent-job-status">
              <span class="status-indicator" [ngClass]="getStatusClass(job.status)"></span>
            </div>
            <div class="recent-job-info">
              <strong>{{ job.jobId }}</strong>
              <p>{{ getJobTypeLabel(job.jobType) }} - {{ getScheduleDescription(job) }}</p>
              <small class="text-muted">
                <span *ngIf="job.execution.lastRunAt">
                  Last run: {{ job.execution.lastRunAt | date: 'short' }}
                </span>
                <span *ngIf="job.status === 'FAILED' && job.execution.lastError">
                  - Error: {{ job.execution.lastError.message }}
                </span>
              </small>
            </div>
            <div class="recent-job-stats">
              <span class="stat-badge success">{{ job.execution.successCount }} ✓</span>
              <span class="stat-badge danger" *ngIf="job.execution.failureCount > 0">
                {{ job.execution.failureCount }} ✗
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .jobs-container {
      padding: 20px;
      max-width: 1400px;
      margin: 0 auto;
    }

    .jobs-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 30px;
    }

    .jobs-header h1 {
      margin: 0;
      font-size: 28px;
      color: #333;
    }

    .jobs-header p {
      margin: 5px 0 0 0;
      color: #666;
    }

    .btn-refresh {
      padding: 10px 20px;
      background: #007bff;
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .btn-refresh:hover {
      background: #0056b3;
    }

    /* Dashboard Stats */
    .dashboard-stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 15px;
      margin-bottom: 30px;
    }

    .stat-card {
      background: white;
      padding: 20px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      text-align: center;
    }

    .stat-value {
      font-size: 32px;
      font-weight: bold;
      color: #007bff;
    }

    .stat-label {
      color: #666;
      font-size: 14px;
      margin-top: 5px;
    }

    /* Filters */
    .filters-section {
      background: white;
      padding: 20px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      margin-bottom: 30px;
      display: flex;
      gap: 20px;
      flex-wrap: wrap;
    }

    .filter-group {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }

    .filter-group label {
      font-size: 14px;
      color: #666;
      font-weight: 500;
    }

    .filter-group select {
      padding: 8px 12px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 14px;
    }

    /* Section */
    .section {
      margin-bottom: 40px;
    }

    .section h2 {
      font-size: 20px;
      margin-bottom: 15px;
      color: #333;
    }

    /* Upcoming Jobs Grid */
    .jobs-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
      gap: 15px;
      margin-bottom: 30px;
    }

    .job-card {
      background: white;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      padding: 15px;
      transition: transform 0.2s, box-shadow 0.2s;
    }

    .job-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 8px rgba(0,0,0,0.15);
    }

    .job-card.upcoming {
      border-left: 4px solid #007bff;
    }

    .job-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }

    .job-id {
      font-family: monospace;
      font-size: 13px;
      color: #666;
    }

    .job-body {
      margin-bottom: 15px;
    }

    .job-info strong {
      font-size: 16px;
      color: #333;
    }

    .schedule-info {
      color: #666;
      font-size: 14px;
      margin: 5px 0;
    }

    .next-run {
      color: #007bff;
      font-size: 14px;
      margin: 5px 0;
      display: flex;
      align-items: center;
      gap: 5px;
    }

    .job-stats {
      display: flex;
      gap: 15px;
      margin-top: 10px;
      font-size: 13px;
      color: #666;
    }

    .job-stats .stat {
      display: flex;
      align-items: center;
      gap: 5px;
    }

    .job-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }

    /* Status Badges */
    .status-badge {
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
    }

    .status-scheduled { background: #e3f2fd; color: #1976d2; }
    .status-processing { background: #fff3e0; color: #f57c00; }
    .status-cached { background: #f3e5f5; color: #7b1fa2; }
    .status-sending { background: #ffe0b2; color: #e65100; }
    .status-completed { background: #e8f5e9; color: #2e7d32; }
    .status-failed { background: #ffebee; color: #c62828; }
    .status-cancelled { background: #f5f5f5; color: #757575; }
    .status-paused { background: #fff9c4; color: #f57f17; }

    /* Jobs Table */
    .jobs-table {
      background: white;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      overflow: hidden;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    thead {
      background: #f8f9fa;
    }

    th {
      padding: 12px;
      text-align: left;
      font-weight: 600;
      font-size: 14px;
      color: #666;
      border-bottom: 2px solid #dee2e6;
    }

    td {
      padding: 12px;
      border-bottom: 1px solid #dee2e6;
      font-size: 14px;
    }

    tr:hover {
      background: #f8f9fa;
    }

    .row-inactive {
      opacity: 0.6;
    }

    .job-id-link {
      color: #007bff;
      cursor: pointer;
      font-family: monospace;
    }

    .job-id-link:hover {
      text-decoration: underline;
    }

    .job-type-badge {
      background: #e9ecef;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
    }

    .schedule-cell {
      line-height: 1.4;
    }

    .operator-cell {
      line-height: 1.3;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .operator-name {
      font-weight: 500;
      color: #333;
    }

    .operator-action {
      font-style: italic;
      color: #666;
    }

    .btn-cancel-small {
      padding: 4px 8px;
      background: #dc3545;
      color: white;
      border: none;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
      align-self: flex-start;
      transition: background-color 0.2s;
    }

    .btn-cancel-small:hover {
      background: #c82333;
    }

    .progress-cell {
      min-width: 150px;
    }

    .progress-bar {
      height: 8px;
      background: #e9ecef;
      border-radius: 4px;
      overflow: hidden;
      margin-bottom: 4px;
    }

    .progress-fill {
      height: 100%;
      transition: width 0.3s;
    }

    .progress-fill.success { background: #28a745; }
    .progress-fill.warning { background: #ffc107; }
    .progress-fill.danger { background: #dc3545; }

    .progress-text {
      font-size: 12px;
      color: #666;
    }

    .action-buttons {
      display: flex;
      gap: 5px;
    }

    .btn-sm, .btn-icon {
      padding: 6px 10px;
      border: 1px solid #ddd;
      background: white;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }

    .btn-sm:hover, .btn-icon:hover {
      background: #f8f9fa;
    }

    .btn-sm:disabled, .btn-icon:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .btn-sm.danger, .btn-icon.danger {
      color: #dc3545;
    }

    /* Loading */
    .loading {
      text-align: center;
      padding: 40px;
    }

    .spinner {
      border: 3px solid #f3f3f3;
      border-top: 3px solid #007bff;
      border-radius: 50%;
      width: 40px;
      height: 40px;
      animation: spin 1s linear infinite;
      margin: 0 auto 15px;
    }

    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }

    /* No Data */
    .no-data {
      text-align: center;
      padding: 60px 20px;
      color: #999;
    }

    .no-data i {
      font-size: 48px;
      margin-bottom: 15px;
    }

    /* Recent Jobs */
    .recent-jobs {
      background: white;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      overflow: hidden;
    }

    .recent-job-item {
      display: flex;
      align-items: center;
      gap: 15px;
      padding: 15px;
      border-bottom: 1px solid #dee2e6;
    }

    .recent-job-item:last-child {
      border-bottom: none;
    }

    .recent-job-status {
      flex-shrink: 0;
    }

    .status-indicator {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      display: block;
    }

    .status-indicator.status-completed { background: #28a745; }
    .status-indicator.status-failed { background: #dc3545; }

    .recent-job-info {
      flex: 1;
    }

    .recent-job-info strong {
      font-family: monospace;
      font-size: 13px;
    }

    .recent-job-info p {
      margin: 5px 0;
      color: #666;
      font-size: 14px;
    }

    .recent-job-stats {
      display: flex;
      gap: 8px;
    }

    .stat-badge {
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
    }

    .stat-badge.success {
      background: #e8f5e9;
      color: #2e7d32;
    }

    .stat-badge.danger {
      background: #ffebee;
      color: #c62828;
    }

    /* Pagination */
    .pagination {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 15px;
      margin-top: 20px;
    }

    .btn-pagination {
      padding: 8px 16px;
      border: 1px solid #ddd;
      background: white;
      border-radius: 4px;
      cursor: pointer;
    }

    .btn-pagination:hover:not(:disabled) {
      background: #f8f9fa;
    }

    .btn-pagination:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .page-info {
      color: #666;
      font-size: 14px;
    }

    .text-muted {
      color: #999;
      font-size: 12px;
    }
  `]
})
export class JobsListComponent implements OnInit, OnDestroy {
  jobs: ScheduledJob[] = [];
  upcomingJobs: ScheduledJob[] = [];
  recentJobs: ScheduledJob[] = [];
  stats: JobStatistics | null = null;
  loading = false;

  // Filters
  filterStatus = '';
  filterType = '';
  filterActive = false;

  // Pagination
  pagination: any = null;
  currentPage = 1;
  pageSize = 20;

  // Auto-refresh
  private refreshSubscription?: Subscription;

  constructor(
    private scheduledJobsService: ScheduledJobsService,
    private toastr: ToastrService,
    private router: Router
  ) {}

  ngOnInit() {
    this.loadDashboardData();

    // Auto-refresh every 30 seconds
    this.refreshSubscription = interval(30000).subscribe(() => {
      this.refreshData();
    });
  }

  ngOnDestroy() {
    if (this.refreshSubscription) {
      this.refreshSubscription.unsubscribe();
    }
  }

  loadDashboardData() {
    this.loadStats();
    this.loadUpcomingJobs();
    this.loadRecentJobs();
    this.loadJobs();
  }

  loadStats() {
    this.scheduledJobsService.getDashboardStats().subscribe({
      next: (response) => {
        if (response.success) {
          this.stats = response.data;
        }
      },
      error: (error) => {
        console.error('Error loading stats:', error);
      }
    });
  }

  loadUpcomingJobs() {
    this.scheduledJobsService.getUpcomingJobs(5).subscribe({
      next: (response) => {
        if (response.success) {
          this.upcomingJobs = response.data;
        }
      },
      error: (error) => {
        console.error('Error loading upcoming jobs:', error);
      }
    });
  }

  loadRecentJobs() {
    this.scheduledJobsService.getRecentJobs(10).subscribe({
      next: (response) => {
        if (response.success) {
          this.recentJobs = response.data;
        }
      },
      error: (error) => {
        console.error('Error loading recent jobs:', error);
      }
    });
  }

  loadJobs() {
    this.loading = true;

    const filters: any = {
      page: this.currentPage,
      limit: this.pageSize
    };

    if (this.filterStatus) filters.status = this.filterStatus;
    if (this.filterType) filters.jobType = this.filterType;
    if (this.filterActive) filters.isActive = true;

    this.scheduledJobsService.getJobs(filters).subscribe({
      next: (response) => {
        if (response.success) {
          this.jobs = response.data.jobs;
          this.pagination = response.data.pagination;
        }
        this.loading = false;
      },
      error: (error) => {
        console.error('Error loading jobs:', error);
        this.toastr.error('Failed to load jobs');
        this.loading = false;
      }
    });
  }

  refreshData() {
    this.loadDashboardData();
    this.toastr.info('Data refreshed', '', { timeOut: 2000 });
  }

  viewJob(job: ScheduledJob) {
    this.router.navigate(['/jobs', job.jobId]);
  }

  executeNow(job: ScheduledJob) {
    if (confirm(`Execute job ${job.jobId} immediately?`)) {
      this.scheduledJobsService.executeJobNow(job._id).subscribe({
        next: (response) => {
          if (response.success) {
            this.toastr.success('Job execution started');
            setTimeout(() => this.loadDashboardData(), 2000);
          }
        },
        error: (error) => {
          console.error('Error executing job:', error);
          this.toastr.error('Failed to execute job');
        }
      });
    }
  }

  pauseJob(job: ScheduledJob) {
    this.scheduledJobsService.pauseJob(job.jobId).subscribe({
      next: (response) => {
        if (response.success) {
          this.toastr.success('Job paused');
          this.loadDashboardData();
        }
      },
      error: (error) => {
        console.error('Error pausing job:', error);
        this.toastr.error('Failed to pause job');
      }
    });
  }

  resumeJob(job: ScheduledJob) {
    this.scheduledJobsService.resumeJob(job.jobId).subscribe({
      next: (response) => {
        if (response.success) {
          this.toastr.success('Job resumed');
          this.loadDashboardData();
        }
      },
      error: (error) => {
        console.error('Error resuming job:', error);
        this.toastr.error('Failed to resume job');
      }
    });
  }

  cancelJob(job: ScheduledJob) {
    if (confirm(`Are you sure you want to cancel job ${job.jobId}? This action cannot be undone.`)) {
      this.scheduledJobsService.cancelJob(job.jobId).subscribe({
        next: (response) => {
          if (response.success) {
            this.toastr.success('Job cancelled');
            this.loadDashboardData();
          }
        },
        error: (error) => {
          console.error('Error cancelling job:', error);
          this.toastr.error('Failed to cancel job');
        }
      });
    }
  }

  previousPage() {
    if (this.currentPage > 1) {
      this.currentPage--;
      this.loadJobs();
    }
  }

  nextPage() {
    if (this.pagination && this.currentPage < this.pagination.pages) {
      this.currentPage++;
      this.loadJobs();
    }
  }

  getStatusClass(status: string): string {
    return this.scheduledJobsService.getStatusClass(status);
  }

  getScheduleDescription(job: ScheduledJob): string {
    return this.scheduledJobsService.getScheduleDescription(job);
  }

  getNextRunDescription(job: ScheduledJob): string {
    return this.scheduledJobsService.getNextRunDescription(job);
  }

  getJobTypeLabel(type: string): string {
    const labels: { [key: string]: string } = {
      'REPORT_GENERATION': 'Report Generation',
      'EMAIL_BATCH': 'Email Batch',
      'FI_DETECTION': 'FI Detection'
    };
    return labels[type] || type;
  }

  getProgressClass(job: ScheduledJob): string {
    const progress = job.progress || 0;
    if (progress === 100) return 'success';
    if (progress > 0) return 'warning';
    return 'danger';
  }

  getLastOperator(job: ScheduledJob): any {
    // First check for execution history to find who ran the job
    if (job.executionHistory && job.executionHistory.length > 0) {
      const sortedHistory = job.executionHistory.sort((a, b) =>
        new Date(b.executedAt).getTime() - new Date(a.executedAt).getTime()
      );

      const lastExecution = sortedHistory[0];
      if (lastExecution && lastExecution.executedBy) {
        return {
          username: lastExecution.executedBy.username,
          email: lastExecution.executedBy.email,
          action: lastExecution.action
        };
      }
    }

    // Fallback to createdBy if no execution history
    if (job.createdBy) {
      return {
        username: job.createdBy.username,
        email: job.createdBy.email,
        action: 'created'
      };
    }

    return null;
  }
}
