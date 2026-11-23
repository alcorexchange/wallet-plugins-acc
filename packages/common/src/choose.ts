import type { UserInterface } from '@wharfkit/session'

export interface Choice<T> {
  label: string
  value: T
}

/**
 * Let the person pick one option in the Session Kit dialog, one button per option.
 * A single option is returned without asking. Closing the dialog rejects.
 */
export function chooseOne<T>(ui: UserInterface, title: string, body: string, choices: Choice<T>[]): Promise<T> {
  if (choices.length === 0) return Promise.reject(new Error(`${title}: nothing to choose from`))
  if (choices.length === 1) return Promise.resolve(choices[0].value)

  return new Promise<T>((resolve, reject) => {
    const prompt = ui.prompt({
      title,
      body,
      elements: choices.map((choice) => ({
        type: 'button' as const,
        data: {
          label: choice.label,
          variant: 'outlined',
          onClick: () => {
            resolve(choice.value)
            // The prompt only ends by cancelling; its rejection is then ignored below.
            prompt.cancel('chosen', true)
          },
        },
      })),
    })
    prompt.then(() => reject(new Error(`${title}: nothing chosen`)), reject)
  })
}
