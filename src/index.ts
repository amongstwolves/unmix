import { VisibilityState, World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { UnmixSystem } from './unmix-system.js';

const landing = document.getElementById('landing') as HTMLDivElement;
const enter = document.getElementById('enter') as HTMLButtonElement;
const notes = document.getElementById('notes') as HTMLDivElement;

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
)
  .then((world) => {
    world.registerSystem(UnmixSystem);

    // The landing page doubles as the loading screen: ready once the world is.
    if (world.xrEnabled) {
      enter.textContent = 'Enter XR';
      enter.disabled = false;
      enter.addEventListener('click', () => world.launchXR());
    } else {
      enter.textContent = 'Open on a Meta Quest';
      notes.textContent = 'Open this page in the Meta Quest browser to start.';
      notes.hidden = false;
    }
    world.visibilityState.subscribe((state) => {
      landing.classList.toggle('hidden', state !== VisibilityState.NonImmersive);
    });
  })
  .catch((error) => {
    console.error('[unmix] failed to start', error);
    enter.textContent = 'Could not start';
    notes.textContent = 'Reload the page to try again.';
    notes.hidden = false;
  });
