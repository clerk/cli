package output

import (
	"fmt"
	"os"

	"github.com/fatih/color"
	"golang.org/x/term"
)

var (
	Bold       = color.New(color.Bold).SprintFunc()
	Dim        = color.New(color.Faint).SprintFunc()
	Cyan       = color.New(color.FgCyan).SprintFunc()
	Green      = color.New(color.FgGreen).SprintFunc()
	Red        = color.New(color.FgRed).SprintFunc()
	Yellow     = color.New(color.FgYellow).SprintFunc()
	Blue       = color.New(color.FgBlue).SprintFunc()
	Magenta    = color.New(color.FgMagenta).SprintFunc()
	White      = color.New(color.FgWhite).SprintFunc()
	BoldCyan   = color.New(color.Bold, color.FgCyan).SprintFunc()
	BoldYellow = color.New(color.Bold, color.FgYellow).SprintFunc()
	BoldGreen  = color.New(color.Bold, color.FgGreen).SprintFunc()
	BoldWhite  = color.New(color.Bold, color.FgWhite).SprintFunc()
)

// Field prints a labeled field with color
func Field(label string, value interface{}) {
	if IsColorEnabled() {
		fmt.Printf("%s %v\n", Dim(label+":"), value)
	} else {
		fmt.Printf("%s: %v\n", label, value)
	}
}

// Header prints a section header with color
func Header(text string) {
	if IsColorEnabled() {
		fmt.Println(BoldYellow(text))
	} else {
		fmt.Println(text)
	}
}

func IsColorEnabled() bool {
	if _, noColor := os.LookupEnv("NO_COLOR"); noColor {
		return false
	}
	if forceColor := os.Getenv("FORCE_COLOR"); forceColor == "1" || forceColor == "true" {
		return true
	}
	return term.IsTerminal(int(os.Stdout.Fd()))
}

func IsInteractive() bool {
	return term.IsTerminal(int(os.Stdin.Fd())) && term.IsTerminal(int(os.Stdout.Fd()))
}

func init() {
	if !IsColorEnabled() {
		color.NoColor = true
	}
}
