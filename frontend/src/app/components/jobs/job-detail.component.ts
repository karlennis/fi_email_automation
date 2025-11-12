import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { ToastrService } from 'ngx-toastr';
import { ScheduledJobsService, ScheduledJob } from '../../services/scheduled-jobs.service';

@Component({
  selector: 'app-job-detail',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="job-detail-container">
      <!-- Header -->
      <div class="detail-header">
        <button class="btn-back" (click)="goBack()">
          <i class="icon-arrow-left"></i> Back to Jobs
        </button>
        <div class="header-actions">
          <button
            class="btn-action"
            (click)="executeNow()"
            [disabled]="!job || job.status === 'PROCESSING' || job.status === 'SENDING'">
            <i class="icon-play"></i> Execute Now
          </button>
          <button
            *ngIf="job && job.status !== 'PAUSED'"
            class="btn-action"
            (click)="pauseJob()">
            <i class="icon-pause"></i> Pause
          </button>
          <button
            *ngIf="job && job.status === 'PAUSED'"
            class="btn-action"
            (click)="resumeJob()">
            <i class="icon-play-circle"></i> Resume
          </button>
          <button class="btn-action danger" (click)="cancelJob()">
            <i class="icon-cancel"></i> Cancel Job
          </button>
        </div>
      </div>

      <div class="loading" *ngIf="loading">
        <div class="spinner"></div>
        <p>Loading job details...</p>
      </div>

      <div *ngIf="!loading && job">
        <!-- Job Overview -->
        <div class="detail-card">
          <h2>Job Overview</h2>
          <div class="detail-grid">
            <div class="detail-item">
              <label>Job ID</label>
              <span class="job-id">{{ job.jobId }}</span>
            </div>
            <div class="detail-item">
              <label>Status</label>
              <span class="status-badge" [ngClass]="getStatusClass(job.status)">
                {{ job.status }}
              </span>
            </div>
            <div class="detail-item">
              <label>Job Type</label>
              <span>{{ getJobTypeLabel(job.jobType) }}</span>
            </div>
            <div class="detail-item">
              <label>Active</label>
              <span>{{ job.isActive ? 'Yes' : 'No' }}</span>
            </div>
            <div class="detail-item">
              <label>Created</label>
              <span>{{ job.createdAt | date: 'medium' }}</span>
            </div>
            <div class="detail-item">
              <label>Last Updated</label>
              <span>{{ job.updatedAt | date: 'medium' }}</span>
            </div>
          </div>

          <div class="detail-item full-width" *ngIf="job.notes">
            <label>Notes</label>
            <p class="notes">{{ job.notes }}</p>
          </div>
        </div>

        <!-- Schedule Information -->
        <div class="detail-card">
          <h2>Schedule Configuration</h2>
          <div class="detail-grid">
            <div class="detail-item">
              <label>Schedule Type</label>
              <span>{{ job.schedule.type }}</span>
            </div>
            <div class="detail-item">
              <label>Description</label>
              <span>{{ getScheduleDescription(job) }}</span>
            </div>
            <div class="detail-item" *ngIf="job.schedule.type === 'CRON'">
              <label>Cron Expression</label>
              <span class="monospace">{{ job.schedule.cronExpression }}</span>
            </div>
            <div class="detail-item" *ngIf="job.schedule.type === 'ONCE'">
              <label>Scheduled For</label>
              <span>{{ job.schedule.scheduledFor | date: 'medium' }}</span>
            </div>
            <div class="detail-item" *ngIf="job.schedule.type === 'WEEKLY'">
              <label>Day of Week</label>
              <span>{{ getDayOfWeekName(job.schedule.dayOfWeek!) }}</span>
            </div>
            <div class="detail-item" *ngIf="job.schedule.type === 'MONTHLY'">
              <label>Day of Month</label>
              <span>{{ job.schedule.dayOfMonth }}</span>
            </div>
            <div class="detail-item" *ngIf="job.schedule.timeOfDay">
              <label>Time of Day</label>
              <span>{{ job.schedule.timeOfDay }}</span>
            </div>
            <div class="detail-item">
              <label>Timezone</label>
              <span>{{ job.schedule.timezone }}</span>
            </div>
          </div>
        </div>

        <!-- Execution Stats -->
        <div class="detail-card">
          <h2>Execution Statistics</h2>
          <div class="stats-grid">
            <div class="stat-box">
              <div class="stat-value">{{ job.execution.runCount }}</div>
              <div class="stat-label">Total Runs</div>
            </div>
            <div class="stat-box success">
              <div class="stat-value">{{ job.execution.successCount }}</div>
              <div class="stat-label">Successful</div>
            </div>
            <div class="stat-box danger">
              <div class="stat-value">{{ job.execution.failureCount }}</div>
              <div class="stat-label">Failed</div>
            </div>
            <div class="stat-box" *ngIf="job.execution.avgProcessingTime">
              <div class="stat-value">{{ formatDuration(job.execution.avgProcessingTime) }}</div>
              <div class="stat-label">Avg Duration</div>
            </div>
          </div>

          <div class="detail-grid">
            <div class="detail-item" *ngIf="job.execution.lastRunAt">
              <label>Last Run</label>
              <span>{{ job.execution.lastRunAt | date: 'medium' }}</span>
            </div>
            <div class="detail-item" *ngIf="job.execution.nextRunAt">
              <label>Next Run</label>
              <span>
                {{ job.execution.nextRunAt | date: 'medium' }}
                <small class="text-muted">({{ getNextRunDescription(job) }})</small>
              </span>
            </div>
          </div>

          <div class="error-box" *ngIf="job.execution.lastError">
            <h3>Last Error</h3>
            <p><strong>Message:</strong> {{ job.execution.lastError.message }}</p>
            <p><small>{{ job.execution.lastError.timestamp | date: 'medium' }}</small></p>
          </div>
        </div>

        <!-- Email Statistics -->
        <div class="detail-card">
          <h2>Email Statistics</h2>
          <div class="stats-grid">
            <div class="stat-box">
              <div class="stat-value">{{ job.emailStats.totalEmails }}</div>
              <div class="stat-label">Total Emails</div>
            </div>
            <div class="stat-box success">
              <div class="stat-value">{{ job.emailStats.sentEmails }}</div>
              <div class="stat-label">Sent</div>
            </div>
            <div class="stat-box danger">
              <div class="stat-value">{{ job.emailStats.failedEmails }}</div>
              <div class="stat-label">Failed</div>
            </div>
            <div class="stat-box warning">
              <div class="stat-value">{{ job.emailStats.bouncedEmails }}</div>
              <div class="stat-label">Bounced</div>
            </div>
          </div>

          <div class="progress-section" *ngIf="job.emailStats.totalEmails > 0">
            <label>Progress</label>
            <div class="progress-bar-large">
              <div
                class="progress-fill"
                [style.width.%]="(job.emailStats.sentEmails / job.emailStats.totalEmails) * 100">
                {{ job.emailStats.sentEmails }} / {{ job.emailStats.totalEmails }}
              </div>
            </div>
          </div>
        </div>

        <!-- Configuration -->
        <div class="detail-card">
          <h2>Job Configuration</h2>
          <div class="detail-grid">
            <div class="detail-item">
              <label>Report Types</label>
              <div class="tag-list">
                <span class="tag" *ngFor="let type of job.config.reportTypes">{{ type }}</span>
              </div>
            </div>
            <div class="detail-item">
              <label>Email Template</label>
              <span>{{ job.config.emailTemplate }}</span>
            </div>
            <div class="detail-item" *ngIf="job.config.customSubject">
              <label>Custom Subject</label>
              <span>{{ job.config.customSubject }}</span>
            </div>
            <div class="detail-item">
              <label>Attach Reports</label>
              <span>{{ job.config.attachReports ? 'Yes' : 'No' }}</span>
            </div>
            <div class="detail-item full-width">
              <label>Project IDs ({{ job.config.projectIds.length }})</label>
              <div class="tag-list scrollable">
                <span class="tag" *ngFor="let id of job.config.projectIds">{{ id }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Cache Information -->
        <div class="detail-card" *ngIf="job.cache">
          <h2>Cached Reports</h2>
          <div class="cache-info">
            <div class="detail-grid">
              <div class="detail-item">
                <label>Reports Cached</label>
                <span>{{ job.cache.reportIds.length || 0 }}</span>
              </div>
              <div class="detail-item">
                <label>Generated At</label>
                <span>{{ job.cache.generatedAt | date: 'medium' }}</span>
              </div>
              <div class="detail-item">
                <label>Expires At</label>
                <span>{{ job.cache.expiresAt | date: 'medium' }}</span>
              </div>
              <div class="detail-item">
                <label>Cache Status</label>
                <span [ngClass]="job.isCacheExpired ? 'text-danger' : 'text-success'">
                  {{ job.isCacheExpired ? 'Expired' : 'Valid' }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- Customers -->
        <div class="detail-card">
          <h2>Customers ({{ job.customers.length }})</h2>
          <div class="customers-table">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Status</th>
                  <th>Sent At</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                <tr *ngFor="let customer of job.customers">
                  <td>{{ customer.name }}</td>
                  <td>{{ customer.email }}</td>
                  <td>
                    <span class="send-status-badge" [ngClass]="getSendStatusClass(customer.sendStatus)">
                      {{ customer.sendStatus }}
                    </span>
                  </td>
                  <td>{{ customer.sentAt ? (customer.sentAt | date: 'short') : '-' }}</td>
                  <td>
                    <span class="error-text" *ngIf="customer.errorMessage">
                      {{ customer.errorMessage }}
                    </span>
                    <span *ngIf="!customer.errorMessage">-</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="no-data" *ngIf="!loading && !job">
        <i class="icon-alert"></i>
        <p>Job not found</p>
      </div>
    </div>
  `,
  styles: [`
    .job-detail-container {
      padding: 20px;
      max-width: 1200px;
      margin: 0 auto;
    }

    .detail-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 30px;
    }

    .btn-back {
      padding: 10px 20px;
      background: #f8f9fa;
      border: 1px solid #dee2e6;
      border-radius: 6px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .btn-back:hover {
      background: #e9ecef;
    }

    .header-actions {
      display: flex;
      gap: 10px;
    }

    .btn-action {
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

    .btn-action:hover:not(:disabled) {
      background: #0056b3;
    }

    .btn-action:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .btn-action.danger {
      background: #dc3545;
    }

    .btn-action.danger:hover {
      background: #c82333;
    }

    .detail-card {
      background: white;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      padding: 25px;
      margin-bottom: 20px;
    }

    .detail-card h2 {
      margin: 0 0 20px 0;
      font-size: 20px;
      color: #333;
    }

    .detail-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 20px;
    }

    .detail-item {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }

    .detail-item.full-width {
      grid-column: 1 / -1;
    }

    .detail-item label {
      font-size: 13px;
      color: #666;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .detail-item span {
      font-size: 15px;
      color: #333;
    }

    .job-id {
      font-family: monospace;
      font-size: 14px;
      background: #f8f9fa;
      padding: 4px 8px;
      border-radius: 4px;
      display: inline-block;
    }

    .notes {
      background: #f8f9fa;
      padding: 10px;
      border-radius: 4px;
      margin: 5px 0 0 0;
      font-size: 14px;
    }

    .monospace {
      font-family: monospace;
      background: #f8f9fa;
      padding: 4px 8px;
      border-radius: 4px;
      display: inline-block;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 15px;
      margin-bottom: 20px;
    }

    .stat-box {
      background: #f8f9fa;
      padding: 20px;
      border-radius: 8px;
      text-align: center;
      border-left: 4px solid #007bff;
    }

    .stat-box.success {
      border-left-color: #28a745;
    }

    .stat-box.danger {
      border-left-color: #dc3545;
    }

    .stat-box.warning {
      border-left-color: #ffc107;
    }

    .stat-value {
      font-size: 28px;
      font-weight: bold;
      color: #333;
    }

    .stat-label {
      font-size: 13px;
      color: #666;
      margin-top: 5px;
    }

    .error-box {
      background: #ffebee;
      border: 1px solid #ef9a9a;
      border-radius: 6px;
      padding: 15px;
      margin-top: 15px;
    }

    .error-box h3 {
      margin: 0 0 10px 0;
      font-size: 16px;
      color: #c62828;
    }

    .error-box p {
      margin: 5px 0;
      font-size: 14px;
      color: #333;
    }

    .progress-section {
      margin-top: 15px;
    }

    .progress-section label {
      font-size: 13px;
      color: #666;
      font-weight: 600;
      display: block;
      margin-bottom: 8px;
    }

    .progress-bar-large {
      height: 30px;
      background: #e9ecef;
      border-radius: 6px;
      overflow: hidden;
      position: relative;
    }

    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #28a745, #20c997);
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      font-weight: 600;
      font-size: 14px;
      transition: width 0.3s;
    }

    .tag-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 5px;
    }

    .tag-list.scrollable {
      max-height: 200px;
      overflow-y: auto;
    }

    .tag {
      background: #e9ecef;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 13px;
      color: #495057;
    }

    .customers-table {
      overflow-x: auto;
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
      font-size: 13px;
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

    .send-status-badge {
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
    }

    .send-status-pending { background: #fff3e0; color: #f57c00; }
    .send-status-sent { background: #e8f5e9; color: #2e7d32; }
    .send-status-failed { background: #ffebee; color: #c62828; }
    .send-status-bounced { background: #fce4ec; color: #880e4f; }

    .error-text {
      color: #dc3545;
      font-size: 12px;
    }

    .status-badge {
      padding: 6px 14px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      display: inline-block;
    }

    .status-scheduled { background: #e3f2fd; color: #1976d2; }
    .status-processing { background: #fff3e0; color: #f57c00; }
    .status-cached { background: #f3e5f5; color: #7b1fa2; }
    .status-sending { background: #ffe0b2; color: #e65100; }
    .status-completed { background: #e8f5e9; color: #2e7d32; }
    .status-failed { background: #ffebee; color: #c62828; }
    .status-cancelled { background: #f5f5f5; color: #757575; }
    .status-paused { background: #fff9c4; color: #f57f17; }

    .text-muted {
      color: #999;
      font-size: 12px;
      margin-left: 5px;
    }

    .text-danger {
      color: #dc3545;
      font-weight: 600;
    }

    .text-success {
      color: #28a745;
      font-weight: 600;
    }

    .loading {
      text-align: center;
      padding: 60px;
    }

    .spinner {
      border: 3px solid #f3f3f3;
      border-top: 3px solid #007bff;
      border-radius: 50%;
      width: 50px;
      height: 50px;
      animation: spin 1s linear infinite;
      margin: 0 auto 20px;
    }

    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }

    .no-data {
      text-align: center;
      padding: 60px 20px;
      color: #999;
    }

    .no-data i {
      font-size: 48px;
      margin-bottom: 15px;
    }
  `]
})
export class JobDetailComponent implements OnInit {
  job: ScheduledJob | null = null;
  loading = false;
  jobId: string = '';

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private scheduledJobsService: ScheduledJobsService,
    private toastr: ToastrService
  ) {}

  ngOnInit() {
    this.route.params.subscribe(params => {
      this.jobId = params['id'];
      this.loadJobDetails();
    });
  }

  loadJobDetails() {
    this.loading = true;
    this.scheduledJobsService.getJobById(this.jobId).subscribe({
      next: (response) => {
        if (response.success) {
          this.job = response.data;
        }
        this.loading = false;
      },
      error: (error) => {
        console.error('Error loading job:', error);
        this.toastr.error('Failed to load job details');
        this.loading = false;
      }
    });
  }

  goBack() {
    this.router.navigate(['/jobs']);
  }

  executeNow() {
    if (!this.job) return;

    if (confirm(`Execute job ${this.job.jobId} immediately?`)) {
      this.scheduledJobsService.executeJobNow(this.job._id).subscribe({
        next: (response) => {
          if (response.success) {
            this.toastr.success('Job execution started');
            setTimeout(() => this.loadJobDetails(), 2000);
          }
        },
        error: (error) => {
          console.error('Error executing job:', error);
          this.toastr.error('Failed to execute job');
        }
      });
    }
  }

  pauseJob() {
    if (!this.job) return;

    this.scheduledJobsService.pauseJob(this.job._id).subscribe({
      next: (response) => {
        if (response.success) {
          this.toastr.success('Job paused');
          this.loadJobDetails();
        }
      },
      error: (error) => {
        console.error('Error pausing job:', error);
        this.toastr.error('Failed to pause job');
      }
    });
  }

  resumeJob() {
    if (!this.job) return;

    this.scheduledJobsService.resumeJob(this.job._id).subscribe({
      next: (response) => {
        if (response.success) {
          this.toastr.success('Job resumed');
          this.loadJobDetails();
        }
      },
      error: (error) => {
        console.error('Error resuming job:', error);
        this.toastr.error('Failed to resume job');
      }
    });
  }

  cancelJob() {
    if (!this.job) return;

    if (confirm(`Are you sure you want to cancel job ${this.job.jobId}? This action cannot be undone.`)) {
      this.scheduledJobsService.cancelJob(this.job._id).subscribe({
        next: (response) => {
          if (response.success) {
            this.toastr.success('Job cancelled');
            this.router.navigate(['/jobs']);
          }
        },
        error: (error) => {
          console.error('Error cancelling job:', error);
          this.toastr.error('Failed to cancel job');
        }
      });
    }
  }

  getStatusClass(status: string): string {
    return this.scheduledJobsService.getStatusClass(status);
  }

  getSendStatusClass(status: string): string {
    return 'send-status-' + status.toLowerCase();
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

  getDayOfWeekName(day: number): string {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return days[day] || 'Unknown';
  }

  formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }
}
