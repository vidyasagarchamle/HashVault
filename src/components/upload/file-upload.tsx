'use client';

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Upload, X, FileIcon, Image, Music, FileText, Video, FolderUp } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { toast } from "sonner";
import { WebHashClient } from '@/lib/webhash-client';
import { storageUpdateEvent, STORAGE_UPDATED } from "@/components/dashboard/StorageUsage";
import { useAuth } from "@/lib/hooks/use-auth";
import { useAccount } from "wagmi";
import { getWalletAddressFromUser } from "@/lib/wallet-utils";
import { useRouter } from 'next/navigation';

interface FileUploadProps {
  onUploadComplete?: () => void;
}

interface UploadingFile {
  file: File;
  progress: number;
  relativePath?: string;
}

export function FileUpload({ onUploadComplete }: FileUploadProps) {
  const { user } = useAuth();
  const { address } = useAccount();
  const router = useRouter();
  const [files, setFiles] = useState<UploadingFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadStartTime, setUploadStartTime] = useState<number | null>(null);
  const [estimatedTimeRemaining, setEstimatedTimeRemaining] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // Format seconds into a readable time format
  const formatTime = (seconds: number): string => {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  };

  // Update time remaining estimate
  useEffect(() => {
    if (!uploading || !uploadStartTime || files.length === 0) {
      setEstimatedTimeRemaining(null);
      return;
    }

    const updateEstimate = () => {
      const timeElapsed = (Date.now() - uploadStartTime) / 1000; // in seconds
      const totalProgress = files.reduce((sum, file) => sum + file.progress, 0) / files.length;
      
      if (totalProgress > 0 && timeElapsed > 0) {
        const estimatedTotalTime = (timeElapsed / totalProgress) * 100;
        const timeRemaining = Math.max(0, estimatedTotalTime - timeElapsed);
        setEstimatedTimeRemaining(formatTime(timeRemaining));
      }
    };

    // Initial update
    updateEstimate();

    // Update every second
    const interval = setInterval(updateEstimate, 1000);
    return () => clearInterval(interval);
  }, [uploading, uploadStartTime, files]);

  const handleSelectClick = () => {
    fileInputRef.current?.click();
  };

  const handleFolderClick = () => {
    folderInputRef.current?.click();
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files || []);
    if (selectedFiles.length > 0) {
      // Check for large files and warn the user
      const largeFiles = selectedFiles.filter(file => file.size > 25 * 1024 * 1024);
      if (largeFiles.length > 0) {
        toast.warning(
          `Some files exceed the recommended size limit (25MB) for reliable uploads. Large files may fail to upload on this deployment.`,
          { duration: 6000 }
        );
      }
      
      const newFiles: UploadingFile[] = selectedFiles.map(file => ({
        file,
        progress: 0,
        relativePath: (file as any).webkitRelativePath || file.name
      }));
      setFiles(newFiles);
    }
  };

  const handleUpload = async () => {
    if (files.length === 0) return;

    // Get wallet address from user object or direct from wagmi
    const walletAddress = getWalletAddressFromUser(user) || address;
    
    if (!walletAddress) {
      toast.error('Please connect your wallet first');
      return;
    }

    try {
      setUploading(true);
      setUploadStartTime(Date.now());

      // Check storage limits first
      const totalSize = files.reduce((sum, file) => sum + file.file.size, 0);
      
      const storageCheckResponse = await fetch('/api/storage/check', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': walletAddress
        },
        body: JSON.stringify({
          fileSize: totalSize
        })
      });

      if (!storageCheckResponse.ok) {
        const error = await storageCheckResponse.json();
        toast.error(error.error || 'Failed to check storage limits');
        return;
      }

      // Upload files using WebHash
      const client = WebHashClient.getInstance();
      const uploadPromises = files.map(async (uploadingFile, index) => {
        try {
          await client.uploadFile({
            file: uploadingFile.file,
            walletAddress,
            onProgress: (progress: number) => {
              setFiles(prev => prev.map((f, i) => 
                i === index ? { ...f, progress } : f
              ));
            }
          });
        } catch (error) {
          console.error(`Error uploading ${uploadingFile.file.name}:`, error);
          toast.error(`Failed to upload ${uploadingFile.file.name}`);
          throw error;
        }
      });

      await Promise.all(uploadPromises);

      // Clear form
      setFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (folderInputRef.current) folderInputRef.current.value = '';

      // Trigger storage update
      storageUpdateEvent.dispatchEvent(new Event(STORAGE_UPDATED));

      toast.success('All files uploaded successfully!');
      
      // Use the onUploadComplete callback to switch to the files view
      if (onUploadComplete) {
        onUploadComplete();
      }
    } catch (error) {
      console.error('Upload error:', error);
      toast.error('Failed to upload some files. Please try again.');
    } finally {
      setUploading(false);
      setUploadStartTime(null);
    }
  };

  const getFileTypeIcon = (mimeType: string) => {
    if (mimeType.startsWith('image/')) return <Image className="w-6 h-6" />;
    if (mimeType.startsWith('audio/')) return <Music className="w-6 h-6" />;
    if (mimeType.startsWith('video/')) return <Video className="w-6 h-6" />;
    if (mimeType.startsWith('application/') || mimeType.startsWith('text/')) {
      return <FileText className="w-6 h-6" />;
    }
    return <FileIcon className="w-6 h-6" />;
  };

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  const getTotalProgress = () => {
    if (files.length === 0) return 0;
    return files.reduce((sum, file) => sum + file.progress, 0) / files.length;
  };

  // Get wallet address for button state
  const walletAddress = getWalletAddressFromUser(user) || address;

  return (
    <Card className="p-6 w-full">
      <div className="space-y-4">
        {/* Hidden file inputs */}
        <input
          ref={fileInputRef}
          type="file"
          onChange={handleFileChange}
          className="hidden"
          multiple
        />
        <input
          ref={folderInputRef}
          type="file"
          onChange={handleFileChange}
          className="hidden"
          {...{ webkitdirectory: "", directory: "" } as any}
        />

        {/* Upload buttons */}
        <div className="flex gap-4">
          <div 
            onClick={handleSelectClick}
            className="flex-1 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-700 p-6 flex flex-col items-center cursor-pointer hover:border-blue-500 dark:hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/50 transition-colors dark:bg-gray-800/50"
          >
            <Upload className="w-12 h-12 text-gray-400 dark:text-gray-500 mb-4" />
            <div className="text-center space-y-2">
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Upload Files</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Select multiple files
              </p>
            </div>
          </div>

          <div 
            onClick={handleFolderClick}
            className="flex-1 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-700 p-6 flex flex-col items-center cursor-pointer hover:border-blue-500 dark:hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/50 transition-colors dark:bg-gray-800/50"
          >
            <FolderUp className="w-12 h-12 text-gray-400 dark:text-gray-500 mb-4" />
            <div className="text-center space-y-2">
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Upload Folder</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Select an entire folder
              </p>
            </div>
          </div>
        </div>

        {/* Selected files */}
        {files.length > 0 && (
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4 bg-white dark:bg-gray-800">
            <div className="font-medium text-gray-900 dark:text-gray-100 mb-2">Selected Files ({files.length})</div>
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {files.map((uploadingFile, index) => (
                <div key={index} className="flex items-center justify-between p-2 rounded-md bg-gray-50 dark:bg-gray-900/50">
                  <div className="flex items-center space-x-2 flex-1 min-w-0">
                    {getFileTypeIcon(uploadingFile.file.type)}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm truncate text-gray-700 dark:text-gray-300" title={uploadingFile.relativePath || uploadingFile.file.name}>
                        {uploadingFile.relativePath || uploadingFile.file.name}
                      </div>
                      {uploadingFile.progress > 0 && uploadingFile.progress < 100 && (
                        <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1.5 mt-1">
                          <div
                            className="bg-blue-600 dark:bg-blue-400 h-1.5 rounded-full transition-all duration-300"
                            style={{ width: `${uploadingFile.progress}%` }}
                          />
                        </div>
                      )}
                    </div>
                    <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">
                      {(uploadingFile.file.size / (1024 * 1024)).toFixed(2)} MB
                    </span>
                  </div>
                  <button
                    onClick={() => removeFile(index)}
                    className="ml-2 text-gray-500 hover:text-red-500 dark:text-gray-400 dark:hover:text-red-400"
                    aria-label="Remove file"
                    disabled={uploading}
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Upload button and progress */}
        <div className="flex flex-col space-y-2">
          {uploading && (
            <div className="text-sm text-gray-500 dark:text-gray-400 flex justify-between">
              <span>{getTotalProgress() < 100 ? `${Math.round(getTotalProgress())}% complete` : "Finalizing..."}</span>
              {estimatedTimeRemaining && getTotalProgress() < 95 && (
                <span>~{estimatedTimeRemaining} remaining</span>
              )}
            </div>
          )}
          
          <div className="flex justify-end">
            <Button
              variant="default"
              onClick={handleUpload}
              disabled={files.length === 0 || uploading || !walletAddress}
              className="flex items-center gap-2"
            >
              {uploading ? (
                <>
                  <div className="w-24 bg-gray-200 dark:bg-gray-700 rounded-full h-2.5 mr-2">
                    <div
                      className="bg-blue-600 dark:bg-blue-400 h-2.5 rounded-full transition-all duration-300"
                      style={{ width: `${getTotalProgress()}%` }}
                    ></div>
                  </div>
                  <span>{getTotalProgress() < 100 ? "Uploading..." : "Finalizing..."}</span>
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4" />
                  <span>Upload {files.length > 0 ? `(${files.length} files)` : ''}</span>
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}