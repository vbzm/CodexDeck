import { api, elements, state, clearNotice } from './core.js';
import { renderProjects, loadProjects, loadProjectThreads } from './sidebar.js';

let currentDirectory = null;
let parentDirectory = null;

async function showDirectory(requestedPath = null) {
  currentDirectory = null;
  parentDirectory = null;
  elements.directoryError.hidden = true;
  elements.directoryList.replaceChildren();
  elements.directoryCurrent.textContent = '正在读取…';
  elements.directorySelect.disabled = true;
  try {
    const query = requestedPath ? '?path=' + encodeURIComponent(requestedPath) : '';
    const result = await api('/api/directories' + query);
    currentDirectory = result.path;
    parentDirectory = result.parent;
    elements.directoryCurrent.textContent = currentDirectory || '此电脑';
    elements.directoryCurrent.title = currentDirectory || '此电脑';
    elements.directoryUp.disabled = !currentDirectory;
    elements.directorySelect.disabled = !currentDirectory;
    if (!result.entries.length) {
      const empty = document.createElement('p');
      empty.className = 'directory-empty';
      empty.textContent = '此处没有子目录';
      elements.directoryList.append(empty);
    }
    for (const entry of result.entries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'directory-entry';
      button.textContent = '▱  ' + entry.name;
      button.title = entry.path;
      button.addEventListener('click', () => showDirectory(entry.path));
      elements.directoryList.append(button);
    }
  } catch (error) {
    elements.directoryCurrent.textContent = requestedPath || '此电脑';
    elements.directoryUp.disabled = false;
    elements.directoryError.textContent = error.message;
    elements.directoryError.hidden = false;
  }
}

export function initProjectDialog() {
  elements.newProject.addEventListener('click', () => {
    elements.projectForm.reset();
    elements.projectError.hidden = true;
    elements.projectDialog.showModal();
    elements.projectName.focus();
  });
  elements.cancelProject.addEventListener('click', () => elements.projectDialog.close());
  elements.projectDialog.addEventListener('click', (event) => {
    if (event.target === elements.projectDialog) elements.projectDialog.close();
  });
  elements.browseProject.addEventListener('click', () => {
    elements.directoryDialog.showModal();
    void showDirectory(elements.projectPath.value.trim() || null);
  });
  elements.directoryUp.addEventListener('click', () => showDirectory(parentDirectory));
  elements.directoryCancel.addEventListener('click', () => elements.directoryDialog.close());
  elements.directorySelect.addEventListener('click', () => {
    if (!currentDirectory) return;
    elements.projectPath.value = currentDirectory;
    if (!elements.projectName.value.trim()) {
      elements.projectName.value = currentDirectory.split(/[\\/]/).filter(Boolean).slice(-1)[0] || '';
    }
    elements.directoryDialog.close();
    elements.projectPath.focus();
  });
  elements.projectForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    elements.projectError.hidden = true;
    elements.createProject.disabled = true;
    try {
      const result = await api('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name: elements.projectName.value.trim(), path: elements.projectPath.value.trim() }),
      });
      state.projects.push(result.project);
      state.expandedProjects.add(result.project.id);
      state.preferredCwd = result.project.roots[0].path;
      elements.projectDialog.close();
      renderProjects();
      void loadProjectThreads(result.project.id);
      void loadProjects();
      clearNotice('action');
    } catch (error) {
      elements.projectError.textContent = error.message;
      elements.projectError.hidden = false;
    } finally {
      elements.createProject.disabled = false;
    }
  });
}
