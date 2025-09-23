import { Component, Input, Output, EventEmitter, forwardRef, OnInit, OnDestroy, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { CustomerService, EmailSuggestion } from '../../../services/customer.service';
import { Subject, debounceTime, distinctUntilChanged, switchMap, of } from 'rxjs';

@Component({
  selector: 'app-email-autocomplete',
  standalone: true,
  imports: [CommonModule, FormsModule],
  styleUrls: ['./email-autocomplete.component.css'],
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => EmailAutocompleteComponent),
      multi: true
    }
  ],
  template: `
    <div class="email-autocomplete">
      <div class="input-container">
        <input
          #emailInput
          type="email"
          [placeholder]="placeholder"
          [(ngModel)]="inputValue"
          (input)="onInputChange($event)"
          (focus)="onFocus()"
          (blur)="onBlur()"
          (keydown)="onKeyDown($event)"
          [class]="inputClass"
          [disabled]="disabled"
        />
        <button
          type="button"
          class="quick-select-btn"
          (click)="loadQuickSelect()"
          [disabled]="disabled"
          title="Show recent customers"
        >
          👥
        </button>
      </div>

      <div class="suggestions-dropdown" *ngIf="showSuggestions && (suggestions.length > 0 || isLoading)">
        <div class="loading-item" *ngIf="isLoading">
          <div class="spinner small"></div>
          <span>Searching customers...</span>
        </div>

        <div
          class="suggestion-item"
          *ngFor="let suggestion of suggestions; let i = index"
          [class.selected]="i === selectedIndex"
          (click)="selectSuggestion(suggestion)"
          (mouseenter)="selectedIndex = i"
        >
          <div class="suggestion-content">
            <div class="suggestion-name">{{ suggestion.name }}</div>
            <div class="suggestion-email">{{ suggestion.email }}</div>
            <div class="suggestion-company" *ngIf="suggestion.company">{{ suggestion.company }}</div>
          </div>
          <div class="suggestion-stats">
            <span class="email-count" *ngIf="suggestion.emailCount > 0">
              {{ suggestion.emailCount }} reports
            </span>
            <div class="report-types">
              <span
                class="report-type-tag small"
                *ngFor="let type of suggestion.reportTypes.slice(0, 3)"
              >
                {{ formatReportType(type) }}
              </span>
              <span class="more-types" *ngIf="suggestion.reportTypes.length > 3">
                +{{ suggestion.reportTypes.length - 3 }}
              </span>
            </div>
          </div>
        </div>

        <div class="no-suggestions" *ngIf="!isLoading && suggestions.length === 0 && inputValue.length >= 2">
          <div class="no-suggestions-content">
            <span>No customers found</span>
            <small>Try a different search term</small>
          </div>
        </div>
      </div>

      <!-- Quick Select Modal -->
      <div class="quick-select-modal" *ngIf="showQuickSelect" (click)="closeQuickSelect()">
        <div class="modal-content" (click)="$event.stopPropagation()">
          <div class="modal-header">
            <h3>Recent Customers</h3>
            <span class="close" (click)="closeQuickSelect()">&times;</span>
          </div>
          <div class="modal-body">
            <div class="quick-select-list">
              <div
                class="quick-select-item"
                *ngFor="let customer of quickSelectCustomers"
                (click)="selectFromQuickSelect(customer)"
              >
                <div class="customer-info">
                  <div class="customer-name">{{ customer.name }}</div>
                  <div class="customer-email">{{ customer.email }}</div>
                  <div class="customer-company" *ngIf="customer.company">{{ customer.company }}</div>
                </div>
                <div class="customer-stats">
                  <span class="email-count">{{ customer.emailCount }} reports</span>
                  <div class="report-types">
                    <span
                      class="report-type-tag small"
                      *ngFor="let type of customer.reportTypes.slice(0, 2)"
                    >
                      {{ formatReportType(type) }}
                    </span>
                  </div>
                </div>
              </div>
            </div>
            <div class="no-quick-select" *ngIf="quickSelectCustomers.length === 0">
              <p>No recent customers found.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  `
})
export class EmailAutocompleteComponent implements OnInit, OnDestroy, ControlValueAccessor {
  @Input() placeholder = 'Enter customer email...';
  @Input() reportType?: string;
  @Input() inputClass = 'form-control';
  @Input() disabled = false;

  @Output() emailSelected = new EventEmitter<EmailSuggestion>();

  @ViewChild('emailInput') emailInput!: ElementRef<HTMLInputElement>;

  inputValue = '';
  suggestions: EmailSuggestion[] = [];
  quickSelectCustomers: any[] = [];
  showSuggestions = false;
  showQuickSelect = false;
  isLoading = false;
  selectedIndex = -1;

  private searchSubject = new Subject<string>();
  private onChange = (value: string) => {};
  private onTouched = () => {};

  constructor(private customerService: CustomerService) {}

  ngOnInit() {
    // Setup debounced search
    this.searchSubject.pipe(
      debounceTime(300),
      distinctUntilChanged(),
      switchMap(query => {
        if (query.length < 2) {
          return of([]);
        }
        this.isLoading = true;
        return this.customerService.getEmailSuggestions(query, this.reportType);
      })
    ).subscribe({
      next: (suggestions) => {
        this.suggestions = suggestions;
        this.isLoading = false;
        this.showSuggestions = true;
        this.selectedIndex = -1;
      },
      error: (error) => {
        console.error('Error fetching email suggestions:', error);
        this.suggestions = [];
        this.isLoading = false;
        this.showSuggestions = false;
      }
    });
  }

  ngOnDestroy() {
    this.searchSubject.complete();
  }

  // ControlValueAccessor implementation
  writeValue(value: string): void {
    this.inputValue = value || '';
  }

  registerOnChange(fn: (value: string) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled = isDisabled;
  }

  onInputChange(event: Event) {
    const target = event.target as HTMLInputElement;
    this.inputValue = target.value;
    this.onChange(this.inputValue);

    if (this.inputValue.length >= 2) {
      this.searchSubject.next(this.inputValue);
    } else {
      this.suggestions = [];
      this.showSuggestions = false;
    }
  }

  onFocus() {
    if (this.suggestions.length > 0) {
      this.showSuggestions = true;
    }
  }

  onBlur() {
    // Delay hiding suggestions to allow for clicks
    setTimeout(() => {
      this.showSuggestions = false;
      this.onTouched();
    }, 200);
  }

  onKeyDown(event: KeyboardEvent) {
    if (!this.showSuggestions || this.suggestions.length === 0) {
      return;
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.selectedIndex = Math.min(this.selectedIndex + 1, this.suggestions.length - 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.selectedIndex = Math.max(this.selectedIndex - 1, -1);
        break;
      case 'Enter':
        event.preventDefault();
        if (this.selectedIndex >= 0 && this.selectedIndex < this.suggestions.length) {
          this.selectSuggestion(this.suggestions[this.selectedIndex]);
        }
        break;
      case 'Escape':
        this.showSuggestions = false;
        this.selectedIndex = -1;
        break;
    }
  }

  selectSuggestion(suggestion: EmailSuggestion) {
    this.inputValue = suggestion.email;
    this.onChange(this.inputValue);
    this.showSuggestions = false;
    this.selectedIndex = -1;
    this.emailSelected.emit(suggestion);

    // Focus back to input
    this.emailInput.nativeElement.focus();
  }

  loadQuickSelect() {
    this.showQuickSelect = true;
    this.customerService.getQuickSelectCustomers(this.reportType).subscribe({
      next: (customers) => {
        this.quickSelectCustomers = customers;
      },
      error: (error) => {
        console.error('Error loading quick select customers:', error);
        this.quickSelectCustomers = [];
      }
    });
  }

  closeQuickSelect() {
    this.showQuickSelect = false;
  }

  selectFromQuickSelect(customer: any) {
    this.inputValue = customer.email;
    this.onChange(this.inputValue);
    this.showQuickSelect = false;

    const suggestion: EmailSuggestion = {
      email: customer.email,
      name: customer.name,
      company: customer.company,
      displayText: customer.company
        ? `${customer.name} (${customer.company}) - ${customer.email}`
        : `${customer.name} - ${customer.email}`,
      reportTypes: customer.reportTypes,
      emailCount: customer.emailCount
    };

    this.emailSelected.emit(suggestion);
    this.emailInput.nativeElement.focus();
  }

  formatReportType(reportType: string): string {
    return reportType.charAt(0).toUpperCase() + reportType.slice(1);
  }
}