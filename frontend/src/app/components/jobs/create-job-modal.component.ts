import { Component, EventEmitter, Input, Output, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ToastrService } from 'ngx-toastr';
import { ScheduledJobsService, CreateJobRequest } from '../../services/scheduled-jobs.service';

@Component({
  selector: 'app-create-job-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="modal-overlay" *ngIf="isOpen" (click)="closeModal()">
      <div class="modal-container" (click)="$event.stopPropagation()">
        <div class="modal-header">
          <h2>Create Scheduled Job</h2>
          <button class="btn-close" (click)="closeModal()">×</button>
        </div>

        <div class="modal-body">
          <!-- Summary of Selected Data -->
          <div class="selection-summary">
            <div class="summary-item">
              <strong>Report Types:</strong>
              <span *ngIf="(prefilledData?.reportTypes?.length ?? 0) > 0">
                {{ prefilledData?.reportTypes?.join(', ') }}
              </span>
              <span *ngIf="(prefilledData?.reportTypes?.length ?? 0) === 0" class="text-muted">
                None selected
              </span>
            </div>
            <div class="summary-item">
              <strong>Projects:</strong>
              <span *ngIf="(prefilledData?.projectIds?.length ?? 0) > 0">
                {{ prefilledData?.projectIds?.length }} project(s)
              </span>
              <span *ngIf="(prefilledData?.projectIds?.length ?? 0) === 0" class="text-muted">
                All projects
              </span>
            </div>
            <div class="summary-item">
              <strong>Customers:</strong>
              <span *ngIf="(prefilledData?.customerIds?.length ?? 0) > 0">
                {{ prefilledData?.customerIds?.length }} customer(s)
              </span>
              <span *ngIf="(prefilledData?.customerIds?.length ?? 0) === 0" class="text-muted">
                None selected
              </span>
            </div>
          </div>

          <!-- Schedule Type -->
          <div class="form-group">
            <label>Schedule Type *</label>
            <select [(ngModel)]="formData.scheduleType" (change)="onScheduleTypeChange()" required>
              <option value="IMMEDIATE">Immediate (Run Now)</option>
              <option value="ONCE">Once (Specific Date/Time)</option>
              <option value="DAILY">Daily</option>
              <option value="WEEKLY">Weekly</option>
              <option value="MONTHLY">Monthly</option>
              <option value="CRON">Cron Expression</option>
            </select>
          </div>

          <!-- Schedule Configuration -->
          <div class="schedule-config">
            <!-- Once: Specific Date/Time -->
            <div class="form-group" *ngIf="formData.scheduleType === 'ONCE'">
              <label>Scheduled For *</label>
              <input type="datetime-local" [(ngModel)]="scheduledForInput" required>
              <small>When should this job run?</small>
            </div>

            <!-- Daily: Time -->
            <div class="form-group" *ngIf="formData.scheduleType === 'DAILY'">
              <label>Time of Day *</label>
              <input type="time" [(ngModel)]="formData.timeOfDay" required>
              <small>Job will run daily at this time</small>
            </div>

            <!-- Weekly: Day + Time -->
            <div class="form-row" *ngIf="formData.scheduleType === 'WEEKLY'">
              <div class="form-group">
                <label>Day of Week *</label>
                <select [(ngModel)]="formData.dayOfWeek" required>
                  <option [value]="0">Sunday</option>
                  <option [value]="1">Monday</option>
                  <option [value]="2">Tuesday</option>
                  <option [value]="3">Wednesday</option>
                  <option [value]="4">Thursday</option>
                  <option [value]="5">Friday</option>
                  <option [value]="6">Saturday</option>
                </select>
              </div>
              <div class="form-group">
                <label>Time of Day *</label>
                <input type="time" [(ngModel)]="formData.timeOfDay" required>
              </div>
            </div>

            <!-- Monthly: Day + Time -->
            <div class="form-row" *ngIf="formData.scheduleType === 'MONTHLY'">
              <div class="form-group">
                <label>Day of Month *</label>
                <input type="number" [(ngModel)]="formData.dayOfMonth" min="1" max="31" required>
                <small>1-31</small>
              </div>
              <div class="form-group">
                <label>Time of Day *</label>
                <input type="time" [(ngModel)]="formData.timeOfDay" required>
              </div>
            </div>

            <!-- Cron Expression -->
            <div class="form-group" *ngIf="formData.scheduleType === 'CRON'">
              <label>Cron Expression *</label>
              <input type="text" [(ngModel)]="formData.cronExpression" placeholder="0 10 * * 5" required>
              <small>Format: minute hour day month dayOfWeek (e.g., "0 10 * * 5" = Fridays at 10 AM)</small>
            </div>

            <!-- Timezone -->
            <div class="form-group" *ngIf="formData.scheduleType !== 'IMMEDIATE'">
              <label>Timezone</label>
              <select [(ngModel)]="formData.timezone">
                <option value="UTC">UTC</option>
                <option value="America/New_York">Eastern Time</option>
                <option value="America/Chicago">Central Time</option>
                <option value="America/Denver">Mountain Time</option>
                <option value="America/Los_Angeles">Pacific Time</option>
                <option value="Europe/London">London</option>
              </select>
            </div>
          </div>

          <!-- Notes -->
          <div class="form-group">
            <label>Notes (Optional)</label>
            <textarea [(ngModel)]="formData.notes" rows="3" placeholder="Add any notes about this scheduled job..."></textarea>
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn-cancel" (click)="closeModal()">Cancel</button>
          <button class="btn-create" (click)="createJob()" [disabled]="!isFormValid() || creating">
            {{ creating ? 'Creating...' : 'Create Job' }}
          </button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      overflow-y: auto;
      padding: 20px;
    }

    .modal-container {
      background: white;
      border-radius: 12px;
      max-width: 700px;
      width: 100%;
      max-height: 90vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 10px 40px rgba(0,0,0,0.2);
    }

    .modal-header {
      padding: 20px 25px;
      border-bottom: 1px solid #dee2e6;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .modal-header h2 {
      margin: 0;
      font-size: 22px;
      color: #333;
    }

    .btn-close {
      background: none;
      border: none;
      font-size: 32px;
      cursor: pointer;
      color: #999;
      line-height: 1;
      padding: 0;
      width: 30px;
      height: 30px;
    }

    .btn-close:hover {
      color: #333;
    }

    .modal-body {
      padding: 25px;
      overflow-y: auto;
      flex: 1;
    }

    .form-group {
      margin-bottom: 20px;
    }

    .form-group label {
      display: block;
      font-weight: 600;
      margin-bottom: 8px;
      color: #333;
      font-size: 14px;
    }

    .form-group input[type="text"],
    .form-group input[type="email"],
    .form-group input[type="number"],
    .form-group input[type="time"],
    .form-group input[type="datetime-local"],
    .form-group select,
    .form-group textarea {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid #ced4da;
      border-radius: 6px;
      font-size: 14px;
      box-sizing: border-box;
    }

    .form-group small {
      display: block;
      margin-top: 5px;
      color: #666;
      font-size: 12px;
    }

    .form-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 15px;
    }

    .selection-summary {
      background: #f8f9fa;
      padding: 15px;
      border-radius: 8px;
      margin-bottom: 20px;
      border-left: 4px solid #007bff;
    }

    .summary-item {
      margin-bottom: 10px;
      font-size: 14px;
    }

    .summary-item:last-child {
      margin-bottom: 0;
    }

    .summary-item strong {
      color: #333;
      margin-right: 8px;
    }

    .summary-item span {
      color: #555;
    }

    .text-muted {
      color: #999 !important;
      font-style: italic;
    }

    .modal-footer {
      padding: 20px 25px;
      border-top: 1px solid #dee2e6;
      display: flex;
      justify-content: flex-end;
      gap: 10px;
    }

    .btn-cancel {
      padding: 10px 24px;
      background: #6c757d;
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 15px;
    }

    .btn-cancel:hover {
      background: #5a6268;
    }

    .btn-create {
      padding: 10px 24px;
      background: #28a745;
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 15px;
    }

    .btn-create:hover:not(:disabled) {
      background: #218838;
    }

    .btn-create:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
  `]
})
export class CreateJobModalComponent implements OnInit {
  @Input() isOpen = false;
  @Input() prefilledData?: Partial<CreateJobRequest>;
  @Output() close = new EventEmitter<void>();
  @Output() jobCreated = new EventEmitter<any>();

  formData: any = {
    jobType: 'EMAIL_BATCH',
    scheduleType: 'IMMEDIATE',
    timezone: 'UTC',
    timeOfDay: '10:00',
    dayOfWeek: 5,
    dayOfMonth: 1
  };

  scheduledForInput = '';
  creating = false;

  constructor(
    private scheduledJobsService: ScheduledJobsService,
    private toastr: ToastrService
  ) {}

  ngOnInit() {
    // No need to load customers or apply prefilled data anymore
    // The parent component already has all the data
  }

  onScheduleTypeChange() {
    // Reset schedule-specific fields
    if (this.formData.scheduleType === 'IMMEDIATE') {
      delete this.formData.scheduledFor;
      delete this.formData.timeOfDay;
      delete this.formData.dayOfWeek;
      delete this.formData.dayOfMonth;
      delete this.formData.cronExpression;
    }
  }

  isFormValid(): boolean {
    if (!this.formData.jobType || !this.formData.scheduleType) return false;

    // Check if we have required data from parent
    if (!this.prefilledData?.reportTypes || this.prefilledData.reportTypes.length === 0) return false;
    if (!this.prefilledData?.customerIds || this.prefilledData.customerIds.length === 0) return false;

    // Schedule-specific validation
    if (this.formData.scheduleType === 'ONCE' && !this.scheduledForInput) return false;
    if (this.formData.scheduleType === 'CRON' && !this.formData.cronExpression) return false;
    if (['DAILY', 'WEEKLY', 'MONTHLY'].includes(this.formData.scheduleType) && !this.formData.timeOfDay) return false;

    return true;
  }

  async createJob() {
    if (!this.isFormValid()) {
      this.toastr.error('Please fill all required fields');
      return;
    }

    this.creating = true;

    try {
      // Build request using prefilled data from parent
      const request: CreateJobRequest = {
        jobType: this.formData.jobType,
        scheduleType: this.formData.scheduleType,
        reportTypes: this.prefilledData!.reportTypes!,
        customerIds: this.prefilledData!.customerIds!
      };

      // Add project IDs if provided
      if (this.prefilledData?.projectIds && this.prefilledData.projectIds.length > 0) {
        request.projectIds = this.prefilledData.projectIds;
      }

      // Add notes if provided
      if (this.formData.notes) {
        request.notes = this.formData.notes;
      }

      // Add timezone for non-immediate jobs
      if (this.formData.scheduleType !== 'IMMEDIATE') {
        request.timezone = this.formData.timezone;
      }

      // Schedule-specific fields
      if (this.formData.scheduleType === 'ONCE') {
        request.scheduledFor = new Date(this.scheduledForInput).toISOString();
      } else if (this.formData.scheduleType === 'DAILY') {
        request.timeOfDay = this.formData.timeOfDay;
      } else if (this.formData.scheduleType === 'WEEKLY') {
        request.dayOfWeek = Number(this.formData.dayOfWeek);
        request.timeOfDay = this.formData.timeOfDay;
      } else if (this.formData.scheduleType === 'MONTHLY') {
        request.dayOfMonth = Number(this.formData.dayOfMonth);
        request.timeOfDay = this.formData.timeOfDay;
      } else if (this.formData.scheduleType === 'CRON') {
        request.cronExpression = this.formData.cronExpression;
      }

      // Create job
      this.scheduledJobsService.createJob(request).subscribe({
        next: (response) => {
          if (response.success) {
            this.toastr.success('Scheduled job created successfully');
            this.jobCreated.emit(response.data);
            this.closeModal();
          }
        },
        error: (error) => {
          console.error('Error creating job:', error);
          this.toastr.error('Failed to create job: ' + (error.error?.message || 'Unknown error'));
          this.creating = false;
        },
        complete: () => {
          this.creating = false;
        }
      });

    } catch (error) {
      console.error('Error creating job:', error);
      this.toastr.error('Failed to create job');
      this.creating = false;
    }
  }

  closeModal() {
    this.close.emit();
  }
}
