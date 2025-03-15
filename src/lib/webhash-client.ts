// import lighthouse from '@lighthouse-web3/sdk';

interface DealParameters {
  miner: string[];
  num_copies: number;
  repair_threshold: number;
  renew_threshold: number;
  replication: number;
  epochs: number;
  skip_ipni: boolean;
  remove_unsealed: boolean;
  deal_duration: number;
  network: string;
  [key: string]: any;
}

interface StorageInfo {
  totalUploaded: number;
  totalSize: number;
}

interface UploadResponse {
  message: string;
  cid: string;
}

interface UploadedFile {
  fileName: string;
  cid: string;
  size: string;
  lastUpdate: string;
  mimeType: string;
}

interface BufferFile {
  name: string;
  buffer?: Buffer | Uint8Array;
  path?: string;
  type: string;
  size: number;
}

interface UploadOptions {
  file: File;
  walletAddress: string;
  onProgress?: (progress: number) => void;
}

interface ProgressData {
  progress: number;
  total: number;
}

export class WebHashClient {
  private static instance: WebHashClient;
  private apiUrl: string;
  private apiKey: string;
  private cache: Map<string, { data: any; timestamp: number }>;
  private static CACHE_DURATION = 5000; // 5 seconds cache

  private constructor() {
    this.apiUrl = process.env.NEXT_PUBLIC_WEBHASH_API_URL || 'http://52.38.175.117:5000';
    this.apiKey = process.env.NEXT_PUBLIC_WEBHASH_API_KEY || '';
    this.cache = new Map();
  }

  public static getInstance(): WebHashClient {
    if (!WebHashClient.instance) {
      WebHashClient.instance = new WebHashClient();
    }
    return WebHashClient.instance;
  }

  private guessMimeType(fileName: string): string {
    const ext = fileName.split('.').pop()?.toLowerCase();
    const mimeTypes: { [key: string]: string } = {
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'gif': 'image/gif',
      'pdf': 'application/pdf',
      'doc': 'application/msword',
      'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'txt': 'text/plain'
    };
    return mimeTypes[ext || ''] || 'application/octet-stream';
  }

  private getCacheKey(method: string, params: string): string {
    return `${method}:${params}`;
  }

  private getFromCache(key: string): any | null {
    const cached = this.cache.get(key);
    if (!cached) return null;

    const now = Date.now();
    if (now - cached.timestamp > WebHashClient.CACHE_DURATION) {
      this.cache.delete(key);
      return null;
    }

    return cached.data;
  }

  private setCache(key: string, data: any): void {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  async getUploads(walletAddress: string): Promise<any[]> {
    try {
      if (!walletAddress) {
        throw new Error('Wallet address is required');
      }

      const cacheKey = this.getCacheKey('getUploads', walletAddress);
      const cached = this.getFromCache(cacheKey);
      if (cached) {
        return cached;
      }
      
      const response = await fetch(`/api/upload?walletAddress=${walletAddress}`, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${walletAddress}`
        }
      });
      
      if (!response.ok) {
        throw new Error(`Failed to fetch uploads: ${response.statusText}`);
      }

      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || 'Failed to fetch uploads');
      }

      this.setCache(cacheKey, data.files);
      return data.files;
    } catch (error) {
      console.error('Error fetching uploads:', error);
      throw error;
    }
  }

  async uploadFile(options: UploadOptions): Promise<any> {
    try {
      const { file, walletAddress, onProgress } = options;

      if (!walletAddress) {
        throw new Error('Wallet address is required');
      }

      if (!file) {
        throw new Error('File is required');
      }

      console.debug('Starting file upload to WebHash...', {
        fileName: file.name,
        fileType: file.type,
        fileSize: file.size,
        walletAddress
      });

      // Check file size and warn about limitations on Vercel
      const fileSizeMB = file.size / (1024 * 1024);
      if (fileSizeMB > 25) {
        console.warn(`File size (${fileSizeMB.toFixed(2)}MB) exceeds recommended limit for Vercel deployments. Consider using direct upload to WebHash or implementing external storage for chunks.`);
      }

      // For small files (< 10MB), use direct upload
      if (file.size < 10 * 1024 * 1024) {
        return this.directUpload(file, walletAddress, onProgress);
      }
      
      // For larger files, use chunked upload
      return this.chunkedUpload(file, walletAddress, onProgress);
    } catch (error) {
      console.error('Upload error:', error);
      throw error;
    }
  }
  
  private async directUpload(file: File, walletAddress: string, onProgress?: (progress: number) => void): Promise<any> {
    // Create FormData for the file
    const formData = new FormData();
    formData.append('file', file);
    
    // Upload to WebHash IPFS endpoint through our proxy API with retry logic
    console.debug('Uploading to WebHash IPFS endpoint via proxy...', {
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type
    });
    
    // Retry logic
    let retries = 3;
    let response;
    let lastError;
    
    while (retries > 0) {
      try {
        // Use our own proxy API endpoint instead of direct external API call
        response = await fetch(`/api/webhash/upload`, {
          method: 'POST',
          body: formData,
          // Add a longer timeout
          signal: AbortSignal.timeout(60000) // 60 second timeout
        });
        
        // If successful, break out of retry loop
        if (response.ok) break;
        
        // If we got a response but it's an error, handle based on status
        const errorText = await response.text();
        console.error('Upload error response:', {
          status: response.status,
          statusText: response.statusText,
          body: errorText
        });
        
        lastError = new Error(`Upload failed: ${response.status} ${response.statusText} - ${errorText}`);
        
        // Don't retry for client errors (4xx)
        if (response.status >= 400 && response.status < 500) {
          throw lastError;
        }
        
      } catch (error) {
        console.error(`Upload attempt failed (${retries} retries left):`, error);
        lastError = error;
      }
      
      retries--;
      if (retries > 0) {
        // Wait before retrying (exponential backoff)
        const waitTime = (3 - retries) * 2000; // 2s, 4s, 6s
        console.debug(`Retrying upload in ${waitTime}ms...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
    
    // If we've exhausted retries and still have an error
    if (!response || !response.ok) {
      throw lastError || new Error('Upload failed after multiple retries');
    }

    try {
      const output = await response.json();
      console.debug('WebHash upload response:', output);
      
      if (onProgress) {
        onProgress(100);
      }
      
      // Continue with the rest of the upload process
      return this.finalizeUpload(output, file, walletAddress);
    } catch (error) {
      console.error('Error parsing WebHash response:', error);
      throw new Error('Failed to parse WebHash response: ' + (error instanceof Error ? error.message : String(error)));
    }
  }
  
  private async chunkedUpload(file: File, walletAddress: string, onProgress?: (progress: number) => void): Promise<any> {
    // Reduce chunk size to 1MB to ensure we stay well within Vercel's 4.5MB request size limit
    const CHUNK_SIZE = 1 * 1024 * 1024; // 1MB chunks instead of 2MB
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    let uploadedChunks = 0;
    let uploadId = Date.now().toString(); // Simple unique ID for this upload
    
    console.debug(`Starting chunked upload with ${totalChunks} chunks of ${CHUNK_SIZE / (1024 * 1024)}MB each`);
    
    // Create array to store chunk responses
    const chunkResponses = [];
    
    // Process each chunk
    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
      const start = chunkIndex * CHUNK_SIZE;
      const end = Math.min(file.size, start + CHUNK_SIZE);
      const chunk = file.slice(start, end);
      
      // Create FormData for the chunk
      const formData = new FormData();
      formData.append('file', chunk, `${file.name}.part${chunkIndex}`);
      formData.append('chunkIndex', chunkIndex.toString());
      formData.append('totalChunks', totalChunks.toString());
      formData.append('uploadId', uploadId);
      formData.append('fileName', file.name);
      
      // Retry logic for each chunk
      let retries = 3;
      let chunkResponse;
      let lastError;
      
      while (retries > 0) {
        try {
          // Upload chunk
          chunkResponse = await fetch(`/api/webhash/upload-chunk`, {
            method: 'POST',
            body: formData,
            signal: AbortSignal.timeout(30000) // 30 second timeout per chunk
          });
          
          if (chunkResponse.ok) break;
          
          const errorText = await chunkResponse.text();
          lastError = new Error(`Chunk upload failed: ${chunkResponse.status} ${chunkResponse.statusText} - ${errorText}`);
          
          // If we get a 413 error (Request Entity Too Large), we need to use even smaller chunks
          if (chunkResponse.status === 413) {
            console.error('Chunk too large for server. Consider using smaller chunks in future uploads.');
            // We'll throw this specific error to handle it specially
            throw new Error('CHUNK_TOO_LARGE');
          }
          
          if (chunkResponse.status >= 400 && chunkResponse.status < 500) {
            throw lastError;
          }
        } catch (error: any) {
          console.error(`Chunk upload failed (${retries} retries left):`, error);
          
          // If this is our special error, we need to break out completely
          if (error.message === 'CHUNK_TOO_LARGE') {
            throw new Error('File upload failed: chunks are too large for the server. Please try a smaller file or contact support.');
          }
          
          lastError = error;
        }
        
        retries--;
        if (retries > 0) {
          const waitTime = (3 - retries) * 1000;
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
      
      if (!chunkResponse || !chunkResponse.ok) {
        throw lastError || new Error(`Failed to upload chunk ${chunkIndex} after multiple retries`);
      }
      
      const chunkResult = await chunkResponse.json();
      chunkResponses.push(chunkResult);
      
      // Update progress
      uploadedChunks++;
      if (onProgress) {
        // Calculate progress based on uploaded chunks
        const progress = Math.floor((uploadedChunks / totalChunks) * 90); // Reserve 10% for finalization
        onProgress(progress);
      }
    }
    
    // All chunks uploaded, now finalize the upload
    console.debug('All chunks uploaded, finalizing...');
    
    // Create FormData for finalization
    const finalizeFormData = new FormData();
    finalizeFormData.append('uploadId', uploadId);
    finalizeFormData.append('fileName', file.name);
    finalizeFormData.append('fileSize', file.size.toString());
    finalizeFormData.append('fileType', file.type);
    finalizeFormData.append('totalChunks', totalChunks.toString());
    
    // Retry logic for finalization
    let retries = 3;
    let finalizeResponse;
    let lastError;
    
    while (retries > 0) {
      try {
        finalizeResponse = await fetch(`/api/webhash/finalize-upload`, {
          method: 'POST',
          body: finalizeFormData,
          signal: AbortSignal.timeout(30000)
        });
        
        if (finalizeResponse.ok) break;
        
        const errorText = await finalizeResponse.text();
        lastError = new Error(`Finalization failed: ${finalizeResponse.status} ${finalizeResponse.statusText} - ${errorText}`);
        
        if (finalizeResponse.status >= 400 && finalizeResponse.status < 500) {
          throw lastError;
        }
      } catch (error) {
        console.error(`Finalization failed (${retries} retries left):`, error);
        lastError = error;
      }
      
      retries--;
      if (retries > 0) {
        const waitTime = (3 - retries) * 2000;
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
    
    if (!finalizeResponse || !finalizeResponse.ok) {
      throw lastError || new Error('Failed to finalize upload after multiple retries');
    }
    
    const output = await finalizeResponse.json();
    console.debug('Finalized upload response:', output);
    
    if (onProgress) {
      onProgress(100);
    }
    
    // Continue with the rest of the upload process
    return this.finalizeUpload(output, file, walletAddress);
  }
  
  private async finalizeUpload(output: any, file: File, walletAddress: string): Promise<any> {
    // Extract CID from the response
    const cid = output.cid || output.hash || output.Hash;
    if (!cid) {
      throw new Error('No CID returned from WebHash API');
    }

    // Save metadata to our database
    let metadataResponse;
    try {
      console.debug('Saving metadata to database:', {
        cid,
        fileName: file.name,
        size: file.size.toString(),
        mimeType: file.type || this.guessMimeType(file.name),
        walletAddress
      });
      
      metadataResponse = await fetch('/api/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': walletAddress
        },
        body: JSON.stringify({
          fileName: file.name,
          cid: cid,
          size: file.size.toString(),
          mimeType: file.type || this.guessMimeType(file.name),
          walletAddress: walletAddress,
        }),
      });

      if (!metadataResponse.ok) {
        const errorText = await metadataResponse.text();
        console.error('Metadata save error response:', errorText);
        throw new Error(`Failed to save metadata: ${errorText || metadataResponse.statusText}`);
      }

      const metadataResult = await metadataResponse.json();
      console.debug('Metadata saved:', metadataResult);

      // Return combined result
      return {
        ...output,
        metadata: metadataResult,
      };
    } catch (error: any) {
      console.error('Error saving metadata:', error);
      // Even if metadata saving fails, return the IPFS result
      // so the user knows the file was uploaded
      return {
        ...output,
        metadataError: error.message,
      };
    }
  }

  async uploadFiles(files: File[], walletAddress: string, onProgress?: (progress: number) => void): Promise<any[]> {
    if (!walletAddress) {
      throw new Error('Wallet address is required');
    }

    const results = [];
    for (const file of files) {
      const result = await this.uploadFile({
        file,
        walletAddress,
        onProgress
      });
      results.push(result);
    }
    return results;
  }

  async deleteFile(cid: string, walletAddress: string): Promise<void> {
    try {
      if (!walletAddress) {
        throw new Error('Wallet address is required');
      }

      // Delete metadata from our database
      const metadataResponse = await fetch(`/api/upload?cid=${cid}&walletAddress=${walletAddress}`, {
        method: 'DELETE'
      });

      if (!metadataResponse.ok) {
        throw new Error(`Failed to delete file metadata: ${metadataResponse.statusText}`);
      }

      console.debug('File metadata deleted successfully:', { cid, walletAddress });
    } catch (error) {
      console.error('Error deleting file:', error);
      throw error;
    }
  }
} 