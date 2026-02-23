import { Injectable, signal, effect } from '@angular/core';

export type Theme = 'light' | 'dark';

@Injectable({
  providedIn: 'root'
})
export class ThemeService {
  private readonly STORAGE_KEY = 'theme';
  
  // Reactive signal for theme state
  currentTheme = signal<Theme>(this.getInitialTheme());
  
  constructor() {
    // Apply theme whenever it changes
    effect(() => {
      this.applyTheme(this.currentTheme());
    });
  }
  
  private getInitialTheme(): Theme {
    // Check localStorage first
    const stored = localStorage.getItem(this.STORAGE_KEY) as Theme;
    if (stored === 'light' || stored === 'dark') {
      return stored;
    }
    
    // Check system preference
    if (typeof window !== 'undefined' && window.matchMedia) {
      if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
        return 'dark';
      }
    }
    
    return 'light';
  }
  
  private applyTheme(theme: Theme): void {
    const root = document.documentElement;
    
    if (theme === 'dark') {
      root.classList.add('dark-mode');
    } else {
      root.classList.remove('dark-mode');
    }
    
    // Persist to localStorage
    localStorage.setItem(this.STORAGE_KEY, theme);
  }
  
  toggle(): void {
    const newTheme = this.currentTheme() === 'light' ? 'dark' : 'light';
    this.currentTheme.set(newTheme);
  }
  
  setTheme(theme: Theme): void {
    this.currentTheme.set(theme);
  }
  
  isDark(): boolean {
    return this.currentTheme() === 'dark';
  }
}
