"""
OpenUI - Local-First OS Assistant
Main entry point.

Usage:
    python main.py                    # Start with GUI overlay
    python main.py --no-gui           # Terminal-only mode
    python main.py --model llama3     # Use a different model
    python main.py --setup            # First-time setup (install model)
"""

import sys
import os
import signal
import argparse
import threading
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent))

from rich.console import Console
from rich.panel import Panel
from rich import print as rprint

console = Console()

try:
    from PyQt5.QtCore import QThread, pyqtSignal
except ImportError:
    QThread = object
    pyqtSignal = None


class CommandWorker(QThread if QThread is not object else object):
    """Worker thread to run autonomous agent commands without blocking PyQt GUI."""
    status_updated = pyqtSignal(str) if pyqtSignal is not None else None
    finished = pyqtSignal(str) if pyqtSignal is not None else None
    error_occurred = pyqtSignal(str) if pyqtSignal is not None else None

    def __init__(self, agent_instance, command_text):
        super().__init__()
        self.agent = agent_instance
        self.command = command_text

    def run(self):
        try:
            # Route status updates back via Qt signal
            self.agent.on_status_update = self.status_updated.emit
            response = self.agent.process_command(self.command)
            self.finished.emit(response)
        except Exception as e:
            self.error_occurred.emit(str(e))

# Global state
app = None
qt_app = None
overlay = None
agent = None
stt = None
tts = None


def parse_args():
    parser = argparse.ArgumentParser(description="OpenUI - Local-First OS Assistant")
    parser.add_argument("--no-gui", action="store_true", help="Run in terminal-only mode (no overlay)")
    parser.add_argument("--model", type=str, default=None, help="Override model name")
    parser.add_argument("--setup", action="store_true", help="Run first-time setup")
    parser.add_argument("--config", type=str, default=None, help="Path to config.yaml")
    return parser.parse_args()


def first_time_setup(config):
    """Run first-time setup: check dependencies, install model."""
    console.print(Panel.fit(
        "[bold]OpenUI First-Time Setup[/bold]\n\n"
        "Let's make sure everything is ready.",
        title="Setup",
        border_style="blue",
    ))

    # Check Python version
    if sys.version_info < (3, 9):
        console.print("[red]Python 3.9+ required. You have {sys.version}[/red]")
        sys.exit(1)

    # Check Ollama
    console.print("\n[1/4] Checking Ollama...")
    from core.helpers import check_ollama_running, install_model

    if not check_ollama_running(config.model_base_url.replace("/v1", "")):
        console.print("[yellow]Ollama is not running![/yellow]")
        console.print("Install Ollama: https://ollama.ai")
        console.print("Then run: [bold]ollama serve[/bold]")
        console.print("\nAfter Ollama is running, start OpenUI again.")
        sys.exit(1)

    console.print("[green]Ollama is running.[/green]")

    # Check model
    console.print(f"\n[2/4] Checking model '{config.model_name}'...")
    from core.helpers import check_model_available
    if not check_model_available(config.model_base_url.replace("/v1", ""), config.model_name):
        console.print(f"[yellow]Model '{config.model_name}' not found. Pulling...[/yellow]")
        console.print("[dim]This may take a few minutes depending on your internet speed.[/dim]")
        success = install_model(config.model_name, config.model_base_url.replace("/v1", ""))
        if success:
            console.print(f"[green]Model '{config.model_name}' installed.[/green]")
        else:
            console.print(f"[red]Failed to install model. Try manually: ollama pull {config.model_name}[/red]")
            sys.exit(1)
    else:
        console.print(f"[green]Model '{config.model_name}' is available.[/green]")

    # Check Tesseract (optional)
    console.print("\n[3/4] Checking Tesseract OCR...")
    try:
        import pytesseract
        pytesseract.get_tesseract_version()
        console.print("[green]Tesseract OCR is installed.[/green]")
    except Exception:
        console.print("[yellow]Tesseract not installed. Screen text reading won't work.[/yellow]")
        console.print("[dim]Install: https://github.com/tesseract-ocr/tesseract[/dim]")

    # Create config file
    console.print("\n[4/4] Creating config file...")
    config.save_yaml("config.yaml")
    console.print("[green]Config saved to config.yaml[/green]")

    console.print(Panel.fit(
        "[bold green]Setup complete![/bold green]\n\n"
        "Start OpenUI with: [bold]python main.py[/bold]\n"
        "Or terminal-only:  [bold]python main.py --no-gui[/bold]",
        border_style="green",
    ))


active_workers = []

def process_command(text: str):
    """Process a user command through the agent, maintaining responsive GUI."""
    global agent, overlay

    if not agent:
        return

    if overlay:
        overlay.set_thinking(True)
        overlay.set_status("Processing...")

        # Instantiate and run QThread worker
        worker = CommandWorker(agent, text)
        worker.status_updated.connect(overlay.set_response)
        
        def on_finished(response):
            overlay.set_response(response)
            overlay.set_thinking(False)
            if worker in active_workers:
                active_workers.remove(worker)
                
        def on_error(err):
            overlay.set_response(f"Error: {err}")
            overlay.set_thinking(False)
            if worker in active_workers:
                active_workers.remove(worker)

        worker.finished.connect(on_finished)
        worker.error_occurred.connect(on_error)
        active_workers.append(worker)
        worker.start()
    else:
        # Terminal-only mode: process synchronously
        try:
            agent.on_status_update = lambda t: console.print(f"[Agent] {t}")
            response = agent.process_command(text)
        except Exception as e:
            console.print(f"[red]Error: {e}[/red]")


def start_voice_input():
    """Start listening for voice input."""
    global stt, overlay

    if not stt:
        return

    if stt.is_listening:
        text = stt.stop_listening()
        if overlay:
            overlay.set_listening_state(False)
        if text:
            process_command(text)
        return

    # Start listening
    try:
        stt.start_listening()
        if overlay:
            overlay.set_listening_state(True)
    except Exception as e:
        console.print(f"[red]Voice error: {e}[/red]")


def run_gui_mode(config):
    """Run OpenUI with PyQt5 GUI overlay."""
    global qt_app, overlay, agent, stt, tts

    from PyQt5.QtWidgets import QApplication, QShortcut
    from PyQt5.QtCore import Qt
    from PyQt5.QtGui import QKeySequence

    qt_app = QApplication(sys.argv)
    qt_app.setQuitOnLastWindowClosed(False)  # Keep running with tray

    # Create overlay
    from ui.overlay import OverlayWindow
    overlay = OverlayWindow(config)
    overlay.command_submitted.connect(process_command)
    overlay.voice_toggled.connect(lambda listening: start_voice_input() if listening else None)
    overlay.show()

    # Create system tray
    if config.ui_system_tray:
        from ui.tray import create_tray_icon
        tray = create_tray_icon(
            on_show_overlay=overlay.toggle_visibility,
            on_toggle_voice=lambda: (start_voice_input()),
            on_quit=qt_app.quit,
        )
        tray.show()

    # Global hotkey: Ctrl+Alt+O for voice
    voice_hotkey = QShortcut(QKeySequence("Ctrl+Alt+O"), overlay)
    voice_hotkey.activated.connect(start_voice_input)

    # Ctrl+Shift+S for settings
    def open_settings():
        from ui.settings import SettingsWindow
        settings = SettingsWindow(config)
        settings.settings_changed.connect(lambda c: print("[Settings] Updated."))
        settings.show()

    settings_hotkey = QShortcut(QKeySequence("Ctrl+Shift+S"), overlay)
    settings_hotkey.activated.connect(open_settings)

    # Speak callback
    def speak_text(text: str):
        if tts:
            tts.speak(text, wait=False)

    agent.set_speak_callback(speak_text)

    console.print("[green]OpenUI running with GUI. Press Ctrl+Alt+O for voice input.[/green]")

    # Run Qt event loop
    qt_app.exec_()


def run_terminal_mode(config):
    """Run OpenUI in terminal-only mode (no GUI)."""
    global agent, stt, tts

    console.print(Panel.fit(
        "[bold]OpenUI Terminal Mode[/bold]\n\n"
        "Type commands below. Type [bold]quit[/bold] to exit, [bold]voice[/bold] for mic input.",
        border_style="blue",
    ))

    # Speak callback
    def speak_text(text: str):
        if tts:
            tts.speak(text, wait=False)

    agent.set_speak_callback(speak_text)

    while True:
        try:
            user_input = console.input("\n[bold cyan]You > [/bold cyan]").strip()

            if not user_input:
                continue
            if user_input.lower() in ("quit", "exit", "q"):
                console.print("[yellow]Goodbye![/yellow]")
                break
            if user_input.lower() == "voice":
                start_voice_input()
                continue
            if user_input.lower() == "clear":
                agent.reset()
                continue
            if user_input.lower() == "help":
                console.print(Panel(
                    "[bold]Commands:[/bold]\n"
                    "  [cyan]quit[/cyan]     - Exit OpenUI\n"
                    "  [cyan]voice[/cyan]    - Start voice input\n"
                    "  [cyan]clear[/cyan]    - Clear conversation\n"
                    "  [cyan]help[/cyan]     - Show this help\n"
                    "  Anything else is sent to the AI agent."
                ))
                continue

            # Process in a thread to keep terminal responsive
            thread = threading.Thread(target=process_command, args=(user_input,), daemon=True)
            thread.start()
            thread.join()

        except KeyboardInterrupt:
            console.print("\n[yellow]Goodbye![/yellow]")
            break


def main():
    """Main entry point."""
    global agent, stt, tts

    args = parse_args()

    # Banner
    console.print(Panel(
        "[bold blue]OpenUI v0.1.0[/bold blue] — Local-First OS Assistant\n"
        "[dim]Runs entirely on your machine. No data leaves your computer.[/dim]",
        border_style="blue",
    ))

    # Load config
    from core.config import load_config
    config = load_config(args.config)

    # Override model if specified
    if args.model:
        config.model_name = args.model
        console.print(f"[dim]Model overridden to: {args.model}[/dim]")

    # First-time setup
    if args.setup:
        first_time_setup(config)
        return

    # Initialize voice
    try:
        from voice.stt import SpeechToText
        from voice.tts import TextToSpeech
        stt = SpeechToText(config)
        tts = TextToSpeech(config)
        console.print("[dim]Voice modules loaded.[/dim]")
    except Exception as e:
        console.print(f"[yellow]Voice modules not available: {e}[/yellow]")
        console.print("[dim]Voice features disabled. Text input still works.[/dim]")

    # Initialize model router
    console.print(f"[dim]Connecting to {config.model_provider} ({config.model_name})...[/dim]")
    from core.router import ModelRouter
    router = ModelRouter(config)

    # Initialize tool registry
    from tools.registry import create_registry
    tools = create_registry(config)

    # Initialize agent
    from core.agent import Agent
    agent = Agent(config, tools, router)

    # Start continuous listening if configured
    if config.voice_stt_engine == "whisper" and getattr(config, "voice_continuous", True):
        try:
            stt.start_continuous_listening(callback=process_command)
            console.print("[green]STT continuous listening active. Say 'OpenUI [command]' to trigger.[/green]")
        except Exception as e:
            console.print(f"[yellow]Could not start continuous voice listening: {e}[/yellow]")

    # Signal handling
    def signal_handler(sig, frame):
        console.print("\n[yellow]Shutting down...[/yellow]")
        if agent:
            agent.shutdown()
        if stt:
            stt.stop_continuous_listening()
        sys.exit(0)

    signal.signal(signal.SIGINT, signal_handler)

    # Run in GUI or terminal mode
    if args.no_gui:
        run_terminal_mode(config)
    else:
        try:
            run_gui_mode(config)
        except ImportError:
            console.print("[yellow]PyQt5 not available. Falling back to terminal mode.[/yellow]")
            console.print("[dim]Install with: pip install PyQt5[/dim]")
            run_terminal_mode(config)


if __name__ == "__main__":
    main()
