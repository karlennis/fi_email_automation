import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ToastrService } from 'ngx-toastr';
import { environment } from '../../../../environments/environment';
import { IconComponent } from '../../shared/icon/icon.component';

interface ReportGroup {
  dateKey: string;
  dateLabel: string;
  reports: any[];
  totalMatches: number;
  sentCount: number;
  collapsed: boolean;
}

@Component({
  selector: 'app-reports-list',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent],
  template: `
    <div class="reports-page">
      <div class="page-header">
        <div>
          <h1>Reports</h1>
          <p class="subtitle">All FI notification reports, grouped by run</p>
        </div>
        <button class="btn btn-secondary" (click)="loadReports()" [disabled]="loading">
          <app-icon name="refresh-cw" [size]="15" [spin]="loading"></app-icon> Refresh
        </button>
      </div>

      <!-- Filters -->
      <div class="filters">
        <div class="filter search">
          <app-icon name="search" [size]="15"></app-icon>
          <input type="text" placeholder="Search customer, email or report ID…"
                 [(ngModel)]="filters.search" (keyup.enter)="loadReports()">
        </div>
        <select [(ngModel)]="filters.status" (change)="loadReports()" class="filter-select">
          <option value="">All statuses</option>
          <option value="GENERATED">Generated</option>
          <option value="SENT">Sent</option>
          <option value="RESENT">Resent</option>
          <option value="FAILED">Failed</option>
        </select>
        <select [(ngModel)]="filters.reportType" (change)="loadReports()" class="filter-select">
          <option value="">All types</option>
          <option value="FI_DETECTION">FI Detection</option>
          <option value="BATCH_FI_NOTIFICATION">Batch Notification</option>
        </select>
        <input type="date" class="filter-select" [(ngModel)]="filters.dateFrom" (change)="loadReports()" title="From date">
        <input type="date" class="filter-select" [(ngModel)]="filters.dateTo" (change)="loadReports()" title="To date">
        <label class="checkbox-filter">
          <input type="checkbox" [(ngModel)]="filters.includeArchived" (change)="loadReports()"> Show archived
        </label>
      </div>

      <!-- Summary -->
      <div class="summary-bar" *ngIf="!loading">
        <span><strong>{{ total }}</strong> reports</span>
        <span><strong>{{ visibleGroups.length }}</strong> of <strong>{{ groups.length }}</strong> runs shown</span>
        <span><strong>{{ totalMatchesAll }}</strong> total matches</span>
      </div>

      <div *ngIf="loading" class="loading-spinner">
        <app-icon name="loader" [size]="18" [spin]="true"></app-icon> Loading reports…
      </div>

      <div *ngIf="!loading && groups.length === 0" class="empty-state">
        <app-icon name="inbox" [size]="18"></app-icon>
        <span>No reports found.</span>
      </div>

      <!-- Grouped reports -->
      <div *ngIf="!loading" class="runs">
        <div class="run-group" *ngFor="let group of visibleGroups">
          <div class="run-header" (click)="group.collapsed = !group.collapsed">
            <div class="run-title">
              <app-icon [name]="group.collapsed ? 'chevron-right' : 'chevron-down'" [size]="16"></app-icon>
              <h3>{{ group.dateLabel }}</h3>
            </div>
            <div class="run-meta">
              <span>{{ group.reports.length }} report{{ group.reports.length === 1 ? '' : 's' }}</span>
              <span>{{ group.totalMatches }} matches</span>
              <span class="run-sent">{{ group.sentCount }} sent</span>
            </div>
          </div>

          <div class="run-body" *ngIf="!group.collapsed">
            <div class="report-row" *ngFor="let report of group.reports" [class.archived]="report.archived">
              <div class="report-main">
                <div class="report-customer">
                  <span class="report-name">{{ report.customerName || report.customerEmail }}</span>
                  <span class="report-email">{{ report.customerEmail }}</span>
                </div>
                <div class="report-tags">
                  <span class="type-badge">{{ formatType(report.reportType) }}</span>
                  <span class="status-badge" [class]="'badge-' + (report.status || '').toLowerCase()">{{ report.status }}</span>
                  <span class="archived-badge" *ngIf="report.archived">Archived</span>
                </div>
              </div>

              <div class="report-figures">
                <div class="figure">
                  <span class="figure-value">{{ report.totalFIMatches }}</span>
                  <span class="figure-label">matches</span>
                </div>
                <div class="figure">
                  <span class="figure-value">{{ report.generatedAt | date:'shortTime' }}</span>
                  <span class="figure-label">generated</span>
                </div>
                <div class="figure">
                  <span class="figure-value" [class]="'delivery-' + (report.lastDeliveryStatus || '').toLowerCase()">
                    {{ report.lastDeliveryStatus || 'NONE' }}
                  </span>
                  <span class="figure-label">delivery</span>
                </div>
              </div>

              <div class="report-row-actions">
                <button class="icon-btn" (click)="viewDetails(report)" title="View details">
                  <app-icon name="eye" [size]="15"></app-icon>
                </button>
                <button class="icon-btn" (click)="openResend(report)" title="Resend / send" [disabled]="!report.canResend">
                  <app-icon name="send" [size]="15"></app-icon>
                </button>
                <button class="icon-btn" (click)="openEdit(report)" title="Edit">
                  <app-icon name="edit" [size]="15"></app-icon>
                </button>
                <button class="icon-btn" (click)="toggleArchive(report)" [title]="report.archived ? 'Unarchive' : 'Archive'">
                  <app-icon name="layers" [size]="15"></app-icon>
                </button>
                <button class="icon-btn danger" (click)="confirmDelete(report)" title="Delete">
                  <app-icon name="trash" [size]="15"></app-icon>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Load more runs -->
      <div *ngIf="!loading && groups.length > visibleRunCount" class="load-more-bar">
        <span class="load-more-label">Showing {{ visibleGroups.length }} of {{ groups.length }} runs</span>
        <button class="btn btn-secondary" (click)="showMoreRuns()">Show 5 more</button>
        <button class="btn btn-secondary" (click)="showAllRuns()">Show all</button>
      </div>
    </div>

    <!-- Details Modal -->
    <div class="modal" *ngIf="showDetailsModal" (click)="closeDetails()">
      <div class="modal-content modal-lg" (click)="$event.stopPropagation()">
        <div class="modal-header">
          <h2><app-icon name="file-text" [size]="18"></app-icon> Report Details</h2>
          <button class="close-btn" (click)="closeDetails()">×</button>
        </div>
        <div class="modal-body">
          <div *ngIf="detailsLoading" class="loading-spinner">
            <app-icon name="loader" [size]="18" [spin]="true"></app-icon> Loading…
          </div>
          <div *ngIf="!detailsLoading && reportDetails">
            <div class="report-summary">
              <span><strong>{{ formatType(reportDetails.reportType) }} Report</strong></span>
              <span class="muted">ID: {{ reportDetails.reportId }}</span>
            </div>
            <div class="detail-grid">
              <div class="stat"><span class="stat-label">Status</span><span class="stat-value">{{ reportDetails.status }}</span></div>
              <div class="stat"><span class="stat-label">Customer</span><span class="stat-value">{{ reportDetails.customerName || '—' }}</span></div>
              <div class="stat"><span class="stat-label">Email</span><span class="stat-value">{{ reportDetails.customerEmail }}</span></div>
              <div class="stat"><span class="stat-label">Scanned</span><span class="stat-value">{{ reportDetails.totalProjectsScanned ?? 0 }}</span></div>
              <div class="stat"><span class="stat-label">Matches</span><span class="stat-value">{{ reportDetails.totalFIMatches ?? 0 }}</span></div>
              <div class="stat"><span class="stat-label">Generated</span><span class="stat-value">{{ reportDetails.generatedAt ? (reportDetails.generatedAt | date:'short') : '—' }}</span></div>
              <div class="stat"><span class="stat-label">Sent</span><span class="stat-value">{{ reportDetails.sentAt ? (reportDetails.sentAt | date:'short') : 'Not sent' }}</span></div>
              <div class="stat"><span class="stat-label">Attempts</span><span class="stat-value">{{ reportDetails.deliveryAttempts?.length ?? 0 }}</span></div>
            </div>

            <div class="form-group">
              <label>Projects Found ({{ reportDetails.projectsFound?.length || 0 }})</label>
              <div *ngIf="!reportDetails.projectsFound?.length" class="empty-state"><span>No project details.</span></div>
              <div class="projects-detail-list" *ngIf="reportDetails.projectsFound?.length">
                <div class="project-detail-card" *ngFor="let p of reportDetails.projectsFound">
                  <div class="project-detail-header">
                    <span class="project-detail-title">{{ p.planningTitle || p.projectId }}</span>
                    <a *ngIf="p.biiUrl" [href]="p.biiUrl" target="_blank" rel="noopener" class="project-detail-link">
                      <app-icon name="eye" [size]="12"></app-icon> View
                    </a>
                  </div>
                  <div class="project-detail-meta">
                    <span *ngIf="p.projectId">ID: {{ p.projectId }}</span>
                    <span *ngIf="p.planningStage">Stage: {{ p.planningStage }}</span>
                    <span *ngIf="p.planningCounty">County: {{ p.planningCounty }}</span>
                  </div>
                </div>
              </div>
            </div>
            <div class="modal-actions">
              <button class="btn btn-secondary" (click)="closeDetails()">Close</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Resend Modal -->
    <div class="modal" *ngIf="showResendModal" (click)="closeResend()">
      <div class="modal-content" (click)="$event.stopPropagation()">
        <div class="modal-header">
          <h2><app-icon name="send" [size]="18"></app-icon> Send Report</h2>
          <button class="close-btn" (click)="closeResend()">×</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>Recipient email(s)</label>
            <input type="text" class="form-control" [(ngModel)]="resendEmail"
                   placeholder="email@example.com (comma-separate for multiple)" [disabled]="resendLoading">
          </div>
          <div class="form-group">
            <label>Email subject (optional)</label>
            <input type="text" class="form-control" [(ngModel)]="resendSubject"
                   placeholder="Leave blank for default subject" [disabled]="resendLoading">
          </div>
          <div class="form-group">
            <div class="matches-header">
              <label>Matches to include</label>
              <div class="matches-actions" *ngIf="resendProjects.length">
                <button type="button" class="link-btn" (click)="setAllMatches(true)" [disabled]="resendLoading">Select all</button>
                <span class="sep">·</span>
                <button type="button" class="link-btn" (click)="setAllMatches(false)" [disabled]="resendLoading">Clear</button>
              </div>
            </div>
            <div *ngIf="resendProjectsLoading" class="loading-spinner">
              <app-icon name="loader" [size]="16" [spin]="true"></app-icon> Loading matches…
            </div>
            <div *ngIf="!resendProjectsLoading && resendProjects.length === 0" class="empty-state"><span>No matches available.</span></div>
            <div class="matches-select-list" *ngIf="!resendProjectsLoading && resendProjects.length > 0">
              <label class="match-row" *ngFor="let p of resendProjects">
                <input type="checkbox" [(ngModel)]="p.include" [disabled]="resendLoading">
                <span class="match-row-text">
                  <span class="match-row-title">{{ p.planningTitle || p.projectId }}</span>
                  <span class="match-row-meta">
                    <span *ngIf="p.planningStage">{{ p.planningStage }}</span>
                    <span *ngIf="p.planningCounty">· {{ p.planningCounty }}</span>
                  </span>
                </span>
              </label>
            </div>
            <span class="matches-count" *ngIf="!resendProjectsLoading && resendProjects.length > 0">
              {{ selectedMatchCount }} of {{ resendProjects.length }} selected
            </span>
          </div>
          <div class="modal-actions">
            <button class="btn btn-secondary" (click)="closeResend()" [disabled]="resendLoading">Cancel</button>
            <button class="btn btn-primary" (click)="sendReport()"
                    [disabled]="!resendEmail || resendLoading || selectedMatchCount === 0">
              <span *ngIf="resendLoading"><app-icon name="loader" [size]="14" [spin]="true"></app-icon> Sending…</span>
              <span *ngIf="!resendLoading"><app-icon name="send" [size]="14"></app-icon> Send Report</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Edit Modal -->
    <div class="modal" *ngIf="showEditModal" (click)="closeEdit()">
      <div class="modal-content" (click)="$event.stopPropagation()">
        <div class="modal-header">
          <h2><app-icon name="edit" [size]="18"></app-icon> Edit Report</h2>
          <button class="close-btn" (click)="closeEdit()">×</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>Recipient email</label>
            <input type="email" class="form-control" [(ngModel)]="editForm.customerEmail" [disabled]="editLoading">
          </div>
          <div class="form-group">
            <label>Email subject</label>
            <input type="text" class="form-control" [(ngModel)]="editForm.subject" placeholder="Default subject" [disabled]="editLoading">
          </div>
          <div class="form-group">
            <label>Notes</label>
            <textarea class="form-control" rows="3" [(ngModel)]="editForm.notes" [disabled]="editLoading"></textarea>
          </div>
          <div class="modal-actions">
            <button class="btn btn-secondary" (click)="closeEdit()" [disabled]="editLoading">Cancel</button>
            <button class="btn btn-primary" (click)="saveEdit()" [disabled]="editLoading">
              <span *ngIf="editLoading"><app-icon name="loader" [size]="14" [spin]="true"></app-icon> Saving…</span>
              <span *ngIf="!editLoading"><app-icon name="save" [size]="14"></app-icon> Save</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Delete Confirm Modal -->
    <div class="modal" *ngIf="showDeleteModal" (click)="closeDelete()">
      <div class="modal-content modal-sm" (click)="$event.stopPropagation()">
        <div class="modal-header">
          <h2><app-icon name="alert-triangle" [size]="18"></app-icon> Delete Report</h2>
          <button class="close-btn" (click)="closeDelete()">×</button>
        </div>
        <div class="modal-body">
          <p>Permanently delete this report? This cannot be undone.</p>
          <div class="report-summary" *ngIf="reportToDelete">
            <span>{{ reportToDelete.customerName || reportToDelete.customerEmail }}</span>
            <span class="muted">{{ reportToDelete.reportId }}</span>
          </div>
          <div class="modal-actions">
            <button class="btn btn-secondary" (click)="closeDelete()" [disabled]="deleteLoading">Cancel</button>
            <button class="btn btn-danger" (click)="deleteReport()" [disabled]="deleteLoading">
              <span *ngIf="deleteLoading"><app-icon name="loader" [size]="14" [spin]="true"></app-icon> Deleting…</span>
              <span *ngIf="!deleteLoading"><app-icon name="trash" [size]="14"></app-icon> Delete</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .reports-page { max-width: 1200px; margin: 0 auto; padding: 24px; }
    .page-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; }
    .page-header h1 { margin: 0; color: var(--text-primary); }
    .subtitle { margin: 4px 0 0; color: var(--text-secondary); font-size: 0.9rem; }

    .filters { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; align-items: center; }
    .filter.search { display: flex; align-items: center; gap: 8px; flex: 1 1 280px; padding: 6px 12px;
      background: var(--bg-secondary); border: 1px solid var(--border, #e0e0e0); border-radius: 6px; color: var(--text-secondary); }
    .filter.search input { border: none; background: transparent; outline: none; flex: 1; color: var(--text-primary); }
    .filter-select { padding: 7px 10px; border: 1px solid var(--border, #e0e0e0); border-radius: 6px;
      background: var(--bg-primary, #fff); color: var(--text-primary); }
    .checkbox-filter { display: flex; align-items: center; gap: 6px; color: var(--text-secondary); font-size: 0.85rem; }

    .summary-bar { display: flex; gap: 20px; margin-bottom: 16px; color: var(--text-secondary); font-size: 0.9rem; }
    .load-more-bar { display: flex; align-items: center; gap: 12px; padding: 16px 0; border-top: 1px solid var(--border, #ececec); margin-top: 4px; }
    .load-more-label { flex: 1; color: var(--text-secondary); font-size: 0.85rem; }
    .summary-bar strong { color: var(--text-primary); }

    .runs { display: flex; flex-direction: column; gap: 14px; }
    .run-group { border: 1px solid var(--border, #e0e0e0); border-radius: 8px; overflow: hidden; }
    .run-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px;
      background: var(--bg-secondary); cursor: pointer; }
    .run-title { display: flex; align-items: center; gap: 8px; }
    .run-title h3 { margin: 0; font-size: 1rem; color: var(--text-primary); }
    .run-meta { display: flex; gap: 16px; font-size: 0.82rem; color: var(--text-secondary); }
    .run-sent { color: var(--success); }

    .run-body { display: flex; flex-direction: column; }
    .report-row { display: flex; align-items: center; gap: 16px; padding: 12px 16px;
      border-top: 1px solid var(--border, #ececec); }
    .report-row.archived { opacity: 0.6; }
    .report-main { flex: 1 1 auto; min-width: 0; }
    .report-customer { display: flex; flex-direction: column; }
    .report-name { font-weight: 600; color: var(--text-primary); }
    .report-email { font-size: 0.8rem; color: var(--text-secondary); }
    .report-tags { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
    .type-badge { padding: 2px 8px; border-radius: 10px; font-size: 0.72rem; background: var(--bg-secondary); color: var(--text-secondary); }
    .status-badge { padding: 2px 10px; border-radius: 10px; font-size: 0.72rem; font-weight: 600; }
    .badge-sent { background: rgba(40,167,69,0.15); color: var(--success); }
    .badge-resent { background: rgba(40,167,69,0.15); color: var(--success); }
    .badge-generated { background: rgba(255,193,7,0.18); color: var(--warning); }
    .badge-failed { background: rgba(220,53,69,0.15); color: var(--error); }
    .archived-badge { padding: 2px 8px; border-radius: 10px; font-size: 0.72rem; background: var(--bg-secondary); color: var(--text-secondary); }

    .report-figures { display: flex; gap: 20px; }
    .figure { display: flex; flex-direction: column; align-items: flex-end; min-width: 60px; }
    .figure-value { font-weight: 600; color: var(--text-primary); font-size: 0.9rem; }
    .figure-label { font-size: 0.7rem; color: var(--text-secondary); text-transform: uppercase; }
    .delivery-success { color: var(--success); }
    .delivery-failed { color: var(--error); }
    .delivery-pending { color: var(--warning); }

    .report-row-actions { display: flex; gap: 4px; }
    .icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px;
      border: 1px solid var(--border, #e0e0e0); background: var(--bg-primary, #fff); border-radius: 6px;
      color: var(--text-secondary); cursor: pointer; }
    .icon-btn:hover:not(:disabled) { color: var(--primary); border-color: var(--primary); }
    .icon-btn.danger:hover:not(:disabled) { color: var(--error); border-color: var(--error); }
    .icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }

    .loading-spinner, .empty-state { display: flex; align-items: center; justify-content: center; gap: 10px;
      padding: 40px; color: var(--text-secondary); }

    /* Modals */
    .modal { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center;
      justify-content: center; z-index: 1000; padding: 20px; }
    .modal-content { background: var(--bg-primary, #fff); border-radius: 10px; width: 100%; max-width: 500px;
      max-height: 90vh; overflow-y: auto; }
    .modal-content.modal-lg { max-width: 800px; }
    .modal-content.modal-sm { max-width: 420px; }
    .modal-header { display: flex; justify-content: space-between; align-items: center; padding: 18px 20px;
      border-bottom: 1px solid var(--border, #ececec); }
    .modal-header h2 { margin: 0; font-size: 1.1rem; display: flex; align-items: center; gap: 8px; color: var(--text-primary); }
    .close-btn { background: none; border: none; font-size: 1.5rem; cursor: pointer; color: var(--text-secondary); line-height: 1; }
    .modal-body { padding: 20px; }
    .form-group { margin-bottom: 16px; display: flex; flex-direction: column; gap: 6px; }
    .form-group label { font-size: 0.85rem; font-weight: 500; color: var(--text-secondary); }
    .form-control { padding: 9px 12px; border: 1px solid var(--border, #e0e0e0); border-radius: 6px;
      background: var(--bg-primary, #fff); color: var(--text-primary); font-family: inherit; }
    .modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }

    .btn { padding: 9px 16px; border-radius: 6px; border: none; cursor: pointer; font-weight: 500;
      display: inline-flex; align-items: center; gap: 6px; }
    .btn:disabled { opacity: 0.55; cursor: not-allowed; }
    .btn-primary { background: var(--primary); color: #fff; }
    .btn-secondary { background: var(--bg-secondary); color: var(--text-primary); }
    .btn-danger { background: var(--error); color: #fff; }

    .report-summary { background: var(--bg-secondary); padding: 14px; border-radius: 6px; margin-bottom: 18px;
      border-left: 4px solid var(--primary); display: flex; flex-direction: column; gap: 4px; }
    .muted { color: var(--text-secondary); font-size: 0.85rem; }

    .detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 14px; margin-bottom: 18px; }
    .stat { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    .stat-label { font-size: 0.75rem; color: var(--text-secondary); }
    .stat-value { font-weight: 600; color: var(--text-primary); overflow-wrap: anywhere; word-break: break-word; }

    .projects-detail-list { display: flex; flex-direction: column; gap: 10px; max-height: 320px; overflow-y: auto; }
    .project-detail-card { padding: 12px; background: var(--bg-secondary); border-radius: 6px; border-left: 3px solid var(--primary); }
    .project-detail-header { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 6px; }
    .project-detail-title { font-weight: 600; color: var(--text-primary); }
    .project-detail-link { display: inline-flex; align-items: center; gap: 4px; font-size: 0.8rem; color: var(--primary); text-decoration: none; }
    .project-detail-meta { display: flex; flex-wrap: wrap; gap: 12px; font-size: 0.8rem; color: var(--text-secondary); }

    .matches-header { display: flex; justify-content: space-between; align-items: center; }
    .matches-actions { display: flex; align-items: center; gap: 6px; }
    .matches-actions .sep { color: var(--text-secondary); }
    .link-btn { background: none; border: none; padding: 0; color: var(--primary); cursor: pointer; font-size: 0.8rem; }
    .link-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .matches-select-list { display: flex; flex-direction: column; gap: 4px; max-height: 240px; overflow-y: auto;
      border: 1px solid var(--border, #e0e0e0); border-radius: 6px; padding: 6px; }
    .match-row { display: flex; align-items: flex-start; gap: 10px; padding: 6px 8px; border-radius: 4px; cursor: pointer; }
    .match-row:hover { background: var(--bg-secondary); }
    .match-row input[type="checkbox"] { margin-top: 3px; }
    .match-row-text { display: flex; flex-direction: column; }
    .match-row-title { color: var(--text-primary); font-size: 0.9rem; }
    .match-row-meta { color: var(--text-secondary); font-size: 0.78rem; }
    .matches-count { display: block; margin-top: 6px; font-size: 0.78rem; color: var(--text-secondary); }

    @media (max-width: 768px) {
      .report-row { flex-wrap: wrap; }
      .report-figures { gap: 14px; }
    }
  `]
})
export class ReportsListComponent implements OnInit {
  private baseUrl = `${environment.apiUrl}/api/reports`;

  loading = false;
  total = 0;
  groups: ReportGroup[] = [];
  visibleRunCount = 5;

  filters = {
    search: '',
    status: '',
    reportType: '',
    dateFrom: '',
    dateTo: '',
    includeArchived: false
  };

  // Details modal
  showDetailsModal = false;
  detailsLoading = false;
  reportDetails: any = null;

  // Resend modal
  showResendModal = false;
  selectedReport: any = null;
  resendEmail = '';
  resendSubject = '';
  resendLoading = false;
  resendProjects: any[] = [];
  resendProjectsLoading = false;

  // Edit modal
  showEditModal = false;
  editLoading = false;
  editForm: { reportId: string; customerEmail: string; subject: string; notes: string } = {
    reportId: '', customerEmail: '', subject: '', notes: ''
  };

  // Delete modal
  showDeleteModal = false;
  deleteLoading = false;
  reportToDelete: any = null;

  constructor(
    private http: HttpClient,
    private toastr: ToastrService
  ) {}

  ngOnInit(): void {
    this.loadReports();
  }

  get visibleGroups(): ReportGroup[] {
    return this.groups.slice(0, this.visibleRunCount);
  }

  showMoreRuns(): void {
    this.visibleRunCount += 5;
  }

  showAllRuns(): void {
    this.visibleRunCount = this.groups.length;
  }

  get totalMatchesAll(): number {
    return this.groups.reduce((sum, g) => sum + g.totalMatches, 0);
  }

  get selectedMatchCount(): number {
    return this.resendProjects.filter(p => p.include).length;
  }

  formatType(type: string): string {
    if (type === 'BATCH_FI_NOTIFICATION') return 'Batch';
    if (type === 'FI_DETECTION') return 'FI Detection';
    return type || '—';
  }

  loadReports(): void {
    this.loading = true;
    const params: any = { limit: '500' };
    if (this.filters.search) params.search = this.filters.search.trim();
    if (this.filters.status) params.status = this.filters.status;
    if (this.filters.reportType) params.reportType = this.filters.reportType;
    if (this.filters.dateFrom) params.dateFrom = this.filters.dateFrom;
    if (this.filters.dateTo) params.dateTo = this.filters.dateTo;
    if (this.filters.includeArchived) params.includeArchived = 'true';

    this.http.get<any>(this.baseUrl, { params }).subscribe({
      next: (response) => {
        const reports = response.data?.reports || [];
        this.total = response.data?.pagination?.total ?? reports.length;
        this.groups = this.groupByRun(reports);
        this.visibleRunCount = 5;
        this.loading = false;
      },
      error: (error) => {
        console.error('Error loading reports:', error);
        this.toastr.error('Failed to load reports');
        this.loading = false;
      }
    });
  }

  private groupByRun(reports: any[]): ReportGroup[] {
    const map = new Map<string, ReportGroup>();

    for (const report of reports) {
      const date = report.generatedAt ? new Date(report.generatedAt) : new Date(0);
      const dateKey = date.toISOString().slice(0, 10);

      if (!map.has(dateKey)) {
        map.set(dateKey, {
          dateKey,
          dateLabel: this.formatDateLabel(date),
          reports: [],
          totalMatches: 0,
          sentCount: 0,
          collapsed: false
        });
      }

      const group = map.get(dateKey)!;
      group.reports.push(report);
      group.totalMatches += report.totalFIMatches || 0;
      if (report.status === 'SENT' || report.status === 'RESENT') {
        group.sentCount += 1;
      }
    }

    return Array.from(map.values()).sort((a, b) => b.dateKey.localeCompare(a.dateKey));
  }

  private formatDateLabel(date: Date): string {
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);

    const sameDay = (a: Date, b: Date) =>
      a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

    const formatted = date.toLocaleDateString(undefined, {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });

    if (sameDay(date, today)) return `Today — ${formatted}`;
    if (sameDay(date, yesterday)) return `Yesterday — ${formatted}`;
    return formatted;
  }

  // --- Details ---
  viewDetails(report: any): void {
    this.showDetailsModal = true;
    this.detailsLoading = true;
    this.reportDetails = null;
    this.http.get<any>(`${this.baseUrl}/${report.reportId}`).subscribe({
      next: (response) => {
        this.reportDetails = response.data;
        this.detailsLoading = false;
      },
      error: (error) => {
        console.error('Error loading report details:', error);
        this.toastr.error('Failed to load report details');
        this.detailsLoading = false;
        this.showDetailsModal = false;
      }
    });
  }

  closeDetails(): void {
    this.showDetailsModal = false;
    this.reportDetails = null;
    this.detailsLoading = false;
  }

  // --- Resend ---
  openResend(report: any): void {
    if (!report.canResend) {
      this.toastr.info('This report cannot be resent');
      return;
    }
    this.selectedReport = report;
    this.resendEmail = report.customerEmail || '';
    this.resendSubject = report.subject || '';
    this.showResendModal = true;
    this.resendProjects = [];
    this.resendProjectsLoading = true;

    this.http.get<any>(`${this.baseUrl}/${report.reportId}`).subscribe({
      next: (response) => {
        const projects = response.data?.projectsFound || [];
        this.resendProjects = projects.map((p: any) => ({ ...p, include: true }));
        this.resendProjectsLoading = false;
      },
      error: (error) => {
        console.error('Error loading matches:', error);
        this.resendProjects = [];
        this.resendProjectsLoading = false;
      }
    });
  }

  setAllMatches(include: boolean): void {
    this.resendProjects.forEach(p => (p.include = include));
  }

  closeResend(): void {
    this.showResendModal = false;
    this.selectedReport = null;
    this.resendEmail = '';
    this.resendSubject = '';
    this.resendLoading = false;
    this.resendProjects = [];
    this.resendProjectsLoading = false;
  }

  sendReport(): void {
    if (!this.selectedReport || !this.resendEmail) return;
    const includedProjectIds = this.resendProjects.filter(p => p.include).map(p => p.projectId);
    if (this.resendProjects.length > 0 && includedProjectIds.length === 0) {
      this.toastr.error('Select at least one match to send');
      return;
    }

    this.resendLoading = true;
    const body: any = {
      newRecipientEmail: this.resendEmail,
      customerId: this.selectedReport.customerId,
      includedProjectIds
    };
    if (this.resendSubject?.trim()) body.subject = this.resendSubject.trim();

    this.http.post<any>(`${this.baseUrl}/${this.selectedReport.reportId}/resend`, body).subscribe({
      next: () => {
        this.toastr.success('Report sent successfully!');
        this.closeResend();
        this.loadReports();
      },
      error: (error) => {
        console.error('Error sending report:', error);
        this.toastr.error(error?.error?.error || 'Failed to send report');
        this.resendLoading = false;
      }
    });
  }

  // --- Edit ---
  openEdit(report: any): void {
    this.editForm = {
      reportId: report.reportId,
      customerEmail: report.customerEmail || '',
      subject: report.subject || '',
      notes: report.notes || ''
    };
    this.showEditModal = true;
  }

  closeEdit(): void {
    this.showEditModal = false;
    this.editLoading = false;
  }

  saveEdit(): void {
    this.editLoading = true;
    const body = {
      customerEmail: this.editForm.customerEmail,
      subject: this.editForm.subject,
      notes: this.editForm.notes
    };
    this.http.patch<any>(`${this.baseUrl}/${this.editForm.reportId}`, body).subscribe({
      next: () => {
        this.toastr.success('Report updated');
        this.closeEdit();
        this.loadReports();
      },
      error: (error) => {
        console.error('Error updating report:', error);
        this.toastr.error(error?.error?.error || 'Failed to update report');
        this.editLoading = false;
      }
    });
  }

  // --- Archive ---
  toggleArchive(report: any): void {
    const archived = !report.archived;
    this.http.post<any>(`${this.baseUrl}/${report.reportId}/archive`, { archived }).subscribe({
      next: () => {
        this.toastr.success(archived ? 'Report archived' : 'Report unarchived');
        this.loadReports();
      },
      error: (error) => {
        console.error('Error archiving report:', error);
        this.toastr.error('Failed to update report');
      }
    });
  }

  // --- Delete ---
  confirmDelete(report: any): void {
    this.reportToDelete = report;
    this.showDeleteModal = true;
  }

  closeDelete(): void {
    this.showDeleteModal = false;
    this.reportToDelete = null;
    this.deleteLoading = false;
  }

  deleteReport(): void {
    if (!this.reportToDelete) return;
    this.deleteLoading = true;
    this.http.delete<any>(`${this.baseUrl}/${this.reportToDelete.reportId}`).subscribe({
      next: () => {
        this.toastr.success('Report deleted');
        this.closeDelete();
        this.loadReports();
      },
      error: (error) => {
        console.error('Error deleting report:', error);
        this.toastr.error(error?.error?.error || 'Failed to delete report');
        this.deleteLoading = false;
      }
    });
  }
}
