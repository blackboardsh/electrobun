export class Sidebar {
  private currentDemo: string = 'windows';
  private onDemoChange?: (demo: string) => void;

  constructor() {
    this.initializeEventListeners();
  }

  private initializeEventListeners() {
    const navItems = document.querySelectorAll('.nav-item');
    
    navItems.forEach(item => {
      item.addEventListener('click', () => {
        const demo = item.getAttribute('data-demo');
        if (demo && demo !== this.currentDemo) {
          this.setActiveDemo(demo);
        }
      });
    });

    // Search functionality
    const searchInput = document.getElementById('search') as HTMLInputElement;
    searchInput?.addEventListener('input', (e) => {
      this.filterDemos((e.target as HTMLInputElement).value);
    });
  }

  setActiveDemo(demo: string) {
    // Remove active class from all items
    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.remove('active');
    });

    // Add active class to selected item
    const selectedItem = document.querySelector(`[data-demo="${demo}"]`);
    selectedItem?.classList.add('active');

    this.currentDemo = demo;
    this.onDemoChange?.(demo);
  }

  private filterDemos(query: string) {
    const lowerQuery = query.toLowerCase();
    const navItems = document.querySelectorAll('.nav-item');

    navItems.forEach(item => {
      const label = item.querySelector('.nav-label')?.textContent?.toLowerCase() || '';
      const demo = item.getAttribute('data-demo')?.toLowerCase() || '';
      
      if (label.includes(lowerQuery) || demo.includes(lowerQuery)) {
        (item as HTMLElement).style.display = 'flex';
      } else {
        (item as HTMLElement).style.display = 'none';
      }
    });
  }

  onDemoChangeCallback(callback: (demo: string) => void) {
    this.onDemoChange = callback;
  }

  getCurrentDemo() {
    return this.currentDemo;
  }
}