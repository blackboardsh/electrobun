import { state } from "../store";

export interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  language: string | null;
  stargazers_count: number;
  updated_at: string;
  clone_url: string;
  ssh_url: string;
  html_url: string;
  default_branch: string;
  owner: {
    login: string;
    avatar_url: string;
  };
}

export interface GitHubOrganization {
  id: number;
  login: string;
  description: string | null;
  avatar_url: string;
}

class GitHubService {
  private baseUrl = 'https://api.github.com';

  private getHeaders() {
    const token = state.appSettings.github.accessToken;
    if (!token) {
      throw new Error('GitHub access token not found');
    }

    return {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Colab-IDE/1.0.0',
    };
  }

  async fetchUserRepositories(options: {
    sort?: 'created' | 'updated' | 'pushed' | 'full_name';
    direction?: 'asc' | 'desc';
    per_page?: number;
    page?: number;
    type?: 'all' | 'owner' | 'member';
  } = {}): Promise<GitHubRepository[]> {
    const {
      sort = 'updated',
      direction = 'desc',
      per_page = 30,
      page = 1,
      type = 'all'
    } = options;

    const url = new URL(`${this.baseUrl}/user/repos`);
    url.searchParams.set('sort', sort);
    url.searchParams.set('direction', direction);
    url.searchParams.set('per_page', per_page.toString());
    url.searchParams.set('page', page.toString());
    url.searchParams.set('type', type);

    const response = await fetch(url.toString(), {
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch repositories: ${response.statusText}`);
    }

    return response.json();
  }

  async fetchOrganizations(): Promise<GitHubOrganization[]> {
    const response = await fetch(`${this.baseUrl}/user/orgs`, {
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch organizations: ${response.statusText}`);
    }

    return response.json();
  }

  async fetchOrganizationRepositories(org: string, options: {
    sort?: 'created' | 'updated' | 'pushed' | 'full_name';
    direction?: 'asc' | 'desc';
    per_page?: number;
    page?: number;
    type?: 'all' | 'public' | 'private' | 'forks' | 'sources' | 'member';
  } = {}): Promise<GitHubRepository[]> {
    const {
      sort = 'updated',
      direction = 'desc',
      per_page = 30,
      page = 1,
      type = 'all'
    } = options;

    const url = new URL(`${this.baseUrl}/orgs/${org}/repos`);
    url.searchParams.set('sort', sort);
    url.searchParams.set('direction', direction);
    url.searchParams.set('per_page', per_page.toString());
    url.searchParams.set('page', page.toString());
    url.searchParams.set('type', type);

    const response = await fetch(url.toString(), {
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch organization repositories: ${response.statusText}`);
    }

    return response.json();
  }

  async searchRepositories(query: string, options: {
    sort?: 'stars' | 'forks' | 'help-wanted-issues' | 'updated';
    order?: 'asc' | 'desc';
    per_page?: number;
    page?: number;
    includeUserFilter?: boolean; // New option to control user filtering
  } = {}): Promise<{ items: GitHubRepository[]; total_count: number }> {
    const {
      sort = 'updated',
      order = 'desc',
      per_page = 30,
      page = 1,
      includeUserFilter = true // Default to true for backward compatibility
    } = options;

    const url = new URL(`${this.baseUrl}/search/repositories`);
    // Only add user filter if requested
    const searchQuery = includeUserFilter ? `${query} user:${state.appSettings.github.username}` : query;
    url.searchParams.set('q', searchQuery);
    url.searchParams.set('sort', sort);
    url.searchParams.set('order', order);
    url.searchParams.set('per_page', per_page.toString());
    url.searchParams.set('page', page.toString());

    const response = await fetch(url.toString(), {
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to search repositories: ${response.statusText}`);
    }

    return response.json();
  }

  async fetchRepository(owner: string, repo: string): Promise<GitHubRepository> {
    const response = await fetch(`${this.baseUrl}/repos/${owner}/${repo}`, {
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Repository not found: ${owner}/${repo}`);
      }
      throw new Error(`Failed to fetch repository: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  async fetchRepositoryBranches(owner: string, repo: string): Promise<Array<{
    name: string;
    commit: { sha: string };
    protected: boolean;
  }>> {
    // Add pagination support - GitHub API returns max 30 branches per page by default
    const url = new URL(`${this.baseUrl}/repos/${owner}/${repo}/branches`);
    url.searchParams.set('per_page', '100'); // Get more branches per page
    
    const response = await fetch(url.toString(), {
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch repository branches: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  isConnected(): boolean {
    return !!(state.appSettings.github.accessToken && state.appSettings.github.username);
  }

  getUsername(): string {
    return state.appSettings.github.username;
  }
}

export const githubService = new GitHubService();