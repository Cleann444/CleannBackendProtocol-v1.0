export class Predictor {
  private transitions: Map<string, Map<string, number>> = new Map();
  private history: string[] = [];
  
  recordTransition(from: string, to: string) {
    if (!this.transitions.has(from)) this.transitions.set(from, new Map());
    const map = this.transitions.get(from)!;
    map.set(to, (map.get(to) || 0) + 1);
  }
  
  predict(url: string): string[] {
    const candidates = this.transitions.get(url);
    if (!candidates) return [];
    const sorted = Array.from(candidates.entries()).sort((a,b) => b[1] - a[1]);
    return sorted.slice(0, 3).map(([url]) => url);
  }
  
  onNavigate(url: string) {
    if (this.history.length) {
      this.recordTransition(this.history[this.history.length-1], url);
    }
    this.history.push(url);
    if (this.history.length > 100) this.history.shift();
  }
}
